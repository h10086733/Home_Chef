# AI 接手指南

更新时间：2026-09-17。先读 [当前状态](CURRENT_STATUS.md)，再按任务定位源文件。不要依赖上一段聊天中的运行状态。

## 5 分钟接手

1. 查看根目录 AGENTS.md、git status --short，保留已有暂存及未提交修改。
2. 读 CURRENT_STATUS.md 的状态、待办和规则差异。
3. 查看相关源文件与测试，检查依赖服务；只确认配置是否存在，不输出配置秘密。
4. 完成改动与对应验证，更新状态及专题说明。不要无条件重新初始化数据库。

## 环境与启动

仓库位于 WSL Ubuntu `/home/qiyun/project/Home_Chef`，Windows 可通过 `\\wsl.localhost\Ubuntu\home\qiyun\project\Home_Chef` 访问。命令以下均在 WSL 仓库根目录运行。其他机器以实际克隆路径为准。

Node 22.12–22.x，pnpm 9.15.0。`scripts/pnpm.sh` 使用约定的 Node 路径（若存在）和 Corepack。系统自带 Node 可能过旧。Windows PowerShell 调用示例：

```powershell
wsl -d Ubuntu -- bash -lc 'cd /home/qiyun/project/Home_Chef && bash scripts/pnpm.sh typecheck'
```

已有环境：

```bash
docker compose -p home-chef-mvp up -d --wait postgres redis
bash scripts/pnpm.sh dev
# 另一个终端
bash scripts/pnpm.sh --filter @home-chef/miniapp dev:h5
```

首次安装才运行 `bash scripts/setup.sh`：安装依赖、创建缺失的 .env、生成客户端、迁移并初始化业务管理员/规则。已有 .env 不要覆盖；不要更换 DATA_KEY，否则已有加密地址和资料无法解密。

| 服务 | 本地端口/用途 |
|---|---|
| API | 3000；`GET /health` 检查数据库连接 |
| 网页及运营后台 | 5173；`/api` 代理到 API |
| H5 | 10086；`/api` 代理到 API |
| 隔离测试 API | 3001；测试脚本启动和停止 |
| PostgreSQL | 55432→容器5432 |
| Redis | 56379→容器6379 |

现有 Compose 项目名是 home-chef-mvp，测试脚本依赖容器名 home-chef-mvp-postgres-1。数据库：home_chef_business 为业务库；home_chef_test、home_chef_test_wechat 为测试库；home_chef 为历史库，不应切换业务到它。

迁移目录以 prisma.config.ts 为准：**db/migrations**。Prisma 配置不自动加载 .env；直接运行迁移前，在本机可信 shell 加载环境：

```bash
set -a; source .env; set +a
bash scripts/pnpm.sh db:generate
bash scripts/pnpm.sh db:migrate
```

不要 `set -x`、输出完整 .env、运行 `db push --force-reset` 或删除业务数据。`db:seed` 是业务初始化；`db:seed:demo` 是历史演示种子，不用于 business。

## 代码定位

| 任务 | 主要入口 |
|---|---|
| HTTP、认证路由、错误/请求日志 | apps/api/src/main.ts |
| 注册、报价、订单、履约、定时处理 | apps/api/src/service.ts |
| 入驻审核、套餐、改约、售后、文件、评价 | apps/api/src/support.ts |
| 用户支付/退款/采购补款/查单 | apps/api/src/payments.ts |
| 结算、余额、提现、分账、财务权限 | apps/api/src/chef-finance.ts |
| 微信 APIv3 签名/验签/解密/OpenID | apps/api/src/wechat-pay.ts |
| 数据模型 / 迁移 / 业务初始化 | prisma/schema.prisma / db/migrations / prisma/bootstrap.ts |
| 队列与定时任务 | apps/worker/src/main.ts；每5秒调用受内部密钥保护的 /internal/tick |
| JSON日志、请求上下文与安全字段 | packages/infrastructure/src/logging.ts |
| 小程序及H5主要页面 | apps/miniapp/src/pages/index/index.tsx；discovery.tsx、income.tsx |
| 小程序支付与地图 | apps/miniapp/src/payments.ts、maps.ts、api.ts |
| 网页与运营界面 | apps/admin-web/src/main.tsx、customer.tsx、orders.tsx、finance.tsx、operations.tsx |
| 浏览器地图选点组件 | packages/map-location/browser.ts |
| 领域规则、历史基础设施 | packages/domain、packages/infrastructure；API中仍有历史store/repository测试实现 |
| 部署与发布检查 | deploy/、scripts/check-release.ts、scripts/configure-wechat.mjs、scripts/build-wechat.sh |

当前业务服务继承链：`Service → MvpService → PaymentService → ChefFinanceService`，main.ts 实例化最后一个。修改基类时检查子类 override；看到 sandbox 方法不能直接推断实际业务在使用它。

## 交易不变量

- 金额统一用整数“分”，服务端报价和订单规则快照为准。
- 提交订单是 PENDING_PAYMENT / UNPAID，实收0。支付验签或可信查单成功才记账及邀请厨师。
- 采购增量 ADDITIONAL 绑定 pendingChange.id，服务器算差额；到账才增加 totalFen、receivedFen 和采购预算，不改变原尾款。拒绝/失效后迟到付款仅退该笔。
- 微信请求使用稳定商户单号重试。网络超时不是失败终态，不另造出款单，不释放不明资金。
- 退款提交成功不是退款到账。累计实收、累计退款及流水分别记录，不以减掉实收冒充退款。
- 提现余额冻结、释放、结算采用追加不可变流水；直接分账不再进入可提现余额。
- 平台交易命令通过事务及全局 PostgreSQL advisory lock 串行保护，档期另有数据库约束。不要绕开以修“慢请求”。
- 订单快照保存资金路径、佣金规则；开关变化不追溯改变旧订单。
- 财务/客服建议审批执行有分权和禁止自审约束；当前不是完整组织权限管理系统。
- 审计写在交易事务中；运行日志不能代替成功提交的账本。详见支付/厨师资金专题。

## 测试选择与边界

```bash
bash scripts/pnpm.sh typecheck
bash scripts/pnpm.sh test
bash scripts/pnpm.sh test:wechat
bash scripts/pnpm.sh test:integration
bash scripts/pnpm.sh test:ui
bash scripts/pnpm.sh build
```

| 命令 | 实际覆盖 / 注意事项 |
|---|---|
| typecheck / test | 类型和各包单元测试，不等于完整业务验收 |
| test:wechat | 先业务夹具，再真实支付代码；隔离库 home_chef_test_wechat、测试密钥和模拟微信响应 |
| test:integration | home_chef_test 历史 sandbox 业务集成：履约、费用、售后、权限、审计等 |
| test:ui | 自动准备网页/H5、启动3001测试API；真实数据交互与地图夹具 |
| test:maps | 同一隔离测试入口，仅跑地图/片区浏览器检查；不要直接运行旧方式 maps-browser.mjs |
| build | 各包及微信小程序构建；H5另用 `--filter @home-chef/miniapp build:h5` |
| release:check | 只读配置/数据库检查，缺配置时非0退出是预期；不代表完成真实权限验证 |
| db:backup | 备份工具；`--verify-restore` 涉及创建/删除隔离恢复库，执行前核对目标与脚本；生产恢复演练未验收 |

数据库测试串行运行：多个脚本共享 `.data/business-fixture.json`，integration/UI/maps 还共用一个测试库。需要 Docker就绪、Playwright Chromium 已安装；依赖缺失应报告，不把启动失败说成业务失败。

专题回归优先，改动影响广泛再跑完整套件。新代码通过需记录当次结果，区分真实服务、模拟外部传输和历史 sandbox 用例。

## 正式发布仍需完成

实际 AppID、支付商户绑定、证书/密钥、转账与分账权限、正式 HTTPS API、微信合法域名和定位权限。网页/H5不具备独立微信支付渠道。不要把本机 .env 或密钥提交、粘贴到对话。

`release:check` 不会部署、不发起真实资金请求；deploy 中的 systemd/Nginx 文件是模板，需要实际服务器路径和证书，并完成启动、回调、队列、日志、备份验收。查看 [当前状态](CURRENT_STATUS.md) 获取未完成队列。