# Home Chef 技术架构与代码分层

**版本：** v0.1（架构基线）  
**适用：** 长沙试运营 MVP  
**依据：** `home-chef-prd-v0.2.md`、`home-chef-transaction-rules-v0.2.md`、`home-chef-technical-nfr-v0.2.md`、`home-chef-compliance-data-v0.2.md`

## 1. 架构结论

现在可以开始代码开发。首版采用**模块化单体（Modular Monolith）+ 独立 Worker + 小程序/后台前端**：

- 一个后端代码仓库，按业务域分模块，模块之间只通过公开应用服务和领域事件交互。
- API、异步 Worker、定时任务使用同一业务代码和数据库模型，但独立部署、独立扩容。
- PostgreSQL 作为订单、资金、状态、规则快照和审计的事实库；Redis 只用于缓存、短期锁、限流和幂等加速，不能作为资金事实源。
- 采用事务内写入业务数据和 Outbox 事件，再由 Worker 投递通知、派单、超时、保险、优惠券和补偿任务。
- 支付、地图、IM、保险、实名、对象存储全部通过 Provider Adapter 接入，开发阶段使用沙箱/Stub，避免第三方未决参数阻塞业务代码。

暂不拆分微服务。订单、支付、退款、结算之间存在强一致事务和复杂竞态，过早拆分会放大分布式事务、对账和排障成本。

## 2. 部署拓扑

```text
微信小程序 ─┐
             ├─ API/BFF ── 模块化领域层 ── PostgreSQL
运营后台 ────┘                  │             ├─ Outbox
                                ├─ Redis       └─ 审计/流水
                                └─ 对象存储

Worker/Timer ── 读取 Outbox、延迟任务、超时任务、补偿任务

Provider Adapters：支付｜地图｜消息/IM｜保险｜实名｜文件扫描
```

生产至少部署 `api`、`worker` 两类进程；定时任务必须具备分布式锁和可重入能力。管理后台可以先与 API 同仓库，前端独立构建。

MVP 开发/测试环境使用 Docker Compose 运行 PostgreSQL、Redis、MinIO（S3 兼容文件存储）和 API/Worker；生产环境可先使用托管 PostgreSQL、Redis 和对象存储，API/Worker 用两组容器部署。这样不把 Kubernetes 运维引入首版。

## 3. 代码仓库建议

采用 TypeScript monorepo。MVP 框架基线确定为：后端 `NestJS + Fastify adapter + Prisma`，用户端 `Taro + React + TypeScript` 微信小程序，运营后台 `React + Vite + Ant Design`，异步任务使用 `BullMQ + Redis`，数据库使用 `PostgreSQL`。这些框架先固定一个 MVP 版本周期，不在开发中途切换；不得改变下面的领域边界。

```text
apps/
  api/                  # NestJS + Fastify：HTTP、鉴权、Webhook、BFF
  worker/               # NestJS standalone + BullMQ：Outbox、延迟任务、补偿、对账、通知
  miniapp/              # Taro + React：用户端微信小程序
  admin-web/            # React + Vite + Ant Design：运营/审核/客服/财务后台
packages/
  domain/               # 领域模型、状态机、金额计算、规则快照
  application/          # 用例编排、事务边界、权限检查
  infrastructure/       # ORM、队列、对象存储、Provider Adapter
  contracts/            # DTO、事件、错误码、OpenAPI/Schema
  observability/        # 日志、审计、指标、Trace
  testkit/              # 时钟、支付沙箱、并发和数据构造器
db/
  migrations/
docs/
```

## 4. 领域模块与所有权

每个模块拥有自己的表、迁移、应用服务和事件处理器；其他模块不得直接写入其表。

| 模块 | 主要职责 | 关键事实 |
|---|---|---|
| identity | 微信登录、手机号、一人一号、会话 | 用户身份与认证状态 |
| user | 地址、偏好、需求、收藏、优惠券领取 | 地址快照与访问授权 |
| chef | 厨师资料、四维审核、试岗、健康证、等级 | 厨师准入和有效期 |
| catalog | 菜系、套餐、服务边界、价格 | 报价来源版本 |
| schedule | 档期、缓冲、片区、距离规则 | 软锁/硬锁及冲突 |
| booking | 预约、报价、订单生命周期 | 订单合同和规则快照 |
| payment | 定金、全款、尾款、增项、退款 | 渠道流水、幂等和净实收 |
| fulfillment | 出发、到达、开始、完成、凭证 | 履约时间线与证据 |
| fee | 采购、代垫、最终费用、佣金 | 分钱计算和费用状态 |
| matching | 候选、抢单、流拍、急单 | 候选快照与唯一绑定 |
| aftersale | 售后、仲裁、赔付/追偿工单 | 证据和冻结 |
| settlement | 结算资格、批次、对账 | 结算流水，不改历史 |
| review | 初评、追评、隐藏、榜单 | 评价窗口与推荐快照 |
| coupon | 券模板、领券、锁券、核销、退券 | 活动版本和券账 |
| risk-content | IM 敏感词、举报、黑名单 | 风控事件和消息留存 |
| insurance | 逐单投保、保单、取消、报案 | Provider 回调与保障状态 |
| notification | 订阅消息、站内信、失败补救 | 发送记录和重试 |
| ops/audit | RBAC、规则发布、人工操作、审计 | 权限、前后值、原因 |

七个订单状态域由 `booking` 统一聚合写入，但状态变更必须调用各域的规则服务；支付、履约、费用、售后、结算、评价不得合并成一个枚举字段。

## 5. 数据与一致性基线

- 所有金额使用 `integer` 分；禁止浮点金额。每笔支付、退款、补款和佣金均有不可变流水。
- 订单成立时保存报价、取消、佣金、区域/档期、优惠券和服务边界快照；后续配置不得重算历史订单。
- 状态变更采用显式命令和状态机；数据库约束拒绝非法转换，API 不接受客户端直接传状态。
- 支付/退款/锁档/抢单/结算/评价/通知均要求业务幂等键；Webhook 先落原始事件，再异步处理。
- 同一事务写入业务变更、审计事件和 Outbox；Worker 至少一次投递，消费者必须幂等。
- 自选硬锁和匹配抢单使用数据库事务 + 行锁/排他约束；Redis 锁只能作为削峰保护，不能替代数据库约束。
- 地址、身份证、健康证、手机号按字段加密/脱敏；完整地址读取必须经过授权服务并写审计。
- 文件只存对象存储引用、哈希、扫描状态和访问审计；业务表不保存不必要的原件内容。

## 6. API 与事件约定

外部 API 按资源和命令划分，例如 `POST /quotes/{id}/pay`、`POST /orders/{id}/accept`、`POST /orders/{id}/cancel`；金额、状态和规则版本由服务端返回，前端不能自行计算最终结果。

事件统一包含：`event_id`、`event_type`、`aggregate_id`、`occurred_at`、`rule_version`、`actor`、`trace_id`、`idempotency_key`。事件示例：

- `OrderPaymentSucceeded` → 待接单、锁档/派单、通知、投保。
- `ChefAcceptedOrder` → 已接单、地址解锁资格、履约准备通知。
- `MatchingExpired` → 流拍、退款、候选补推/补偿券、通知。
- `ServiceCompletedConfirmed` → 评价窗口、结算资格检查、通知。
- `RefundSucceeded` / `SettlementSucceeded` → 流水汇总、对账和审计。

## 7. 开发顺序

1. 工程基座：鉴权、RBAC、数据库迁移、审计、错误码、幂等、时钟、Outbox、Provider 接口。
2. 主链路：厨师/套餐/档期 → 预约/报价 → 定金或全款沙箱支付 → 自选接单/匹配抢单 → 履约时间线。
3. 资金闭环：采购费用、最终费用、尾款、退款、佣金、结算和对账；先完成无优惠样例，再接券账。
4. 风控与保障：地址解锁、IM 敏感词与留存、保险绑定/报案、通知失败补救。
5. 运营后台：审核、片区、规则版本、售后仲裁、财务审批、BI 和导出。
6. 验收与上线：按 `home-chef-acceptance-matrix-v0.2.md` 编写 API/集成/并发/恢复测试。

## 8. 当前可开发范围与上线门禁

可以立即开发：领域模型、状态机、金额计算、报价/档期、订单、沙箱支付、退款请求、匹配并发、履约凭证、审计、通知、RBAC 和后台骨架。第三方使用 Adapter + Stub，不伪造生产成功状态。

不得宣称可上线，直到 `BLK-REGION-001`、`BLK-ENTITY-001`、`BLK-PAY-001`、`BLK-CHEF-HEALTH-001`、`BLK-SETTLE-001`、`BLK-FOOD-001`、`BLK-RETENTION-001` 关闭，并完成对应验收证据。尾款规则、临近取消比例、流拍 N 分钟、优惠券分摊和佣金费率等 DTL 参数未发布前，只能做配置接口和待执行测试，不能写死为生产规则。

## 9. MVP 技术栈与取舍

| 层 | MVP 选择 | 说明 |
|---|---|---|
| 用户端 | Taro + React + TypeScript | 一套代码优先支持微信小程序；不为 MVP 同时维护原生小程序和 App。 |
| 运营后台 | React + Vite + Ant Design + TanStack Query | 后台表格、权限、审核和财务操作开发效率高；服务端仍强制 RBAC。 |
| API | NestJS + Fastify + TypeScript | 模块化、依赖注入、OpenAPI、Webhook 和测试能力适合复杂交易域。 |
| ORM/数据库 | Prisma + PostgreSQL 16 | 迁移、类型安全和事务支持；金额用整数分，时间统一 UTC 存储并按 Asia/Shanghai 展示。 |
| 异步任务 | BullMQ + Redis 7 | 处理 5 分钟接单、流拍、72h 确认、通知、退款补偿和对账；任务必须幂等。 |
| 文件 | S3 兼容对象存储 + 服务端扫描 | 身份/健康/凭证不落本地磁盘；数据库只保存对象引用、哈希和扫描状态。 |
| 可观测性 | Pino + OpenTelemetry + Prometheus/Grafana | 结构化日志、Trace、业务指标和 P0/P1 告警。 |
| 测试 | Vitest + Supertest + Playwright | 领域单测、API 集成、后台/小程序关键流程和并发竞态测试。 |
| 工具链 | pnpm + Turborepo + ESLint + Prettier | 统一 monorepo 构建、缓存、检查和 CI。 |

MVP 不引入 Kafka、Kubernetes、微服务网格或复杂 CQRS；当订单/支付/匹配/通知出现独立扩容或团队边界需求时，再按模块事件拆分服务。

## 10. 首轮架构评审清单

- 确认 TypeScript monorepo、NestJS/Fastify、Taro/React、React/Vite、Prisma、BullMQ/Redis 和 PostgreSQL 版本。
- 确认支付、保险、实名、地图、消息/IM、对象存储供应商及沙箱凭证管理。
- 确认 DTL 参数的配置模型、发布审批和历史快照字段。
- 确认数据保留、删除/导出、密钥管理和审计存储周期。
- 确认首批片区、容量、客服值班和故障人工接管流程。
