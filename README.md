微信支付接入代码已完成，当前缺少商户配置，真实扣款与退款待真机验证。配置与测试见 [微信支付接入说明](docs/wechat-pay.md)。

# 厨临门 / Home Chef

当前应用运行于 **business 模式**，连接 PostgreSQL 业务库。注册、地址、服务者入驻、审核、套餐、档期、搜索、收藏和订单均使用数据库；不会自动填充演示厨师或订单。

## 本地启动
需要 Node 22、Docker、PostgreSQL/Redis（由 Compose 启动）。
在项目根目录执行：
```bash
bash scripts/setup.sh
bash scripts/pnpm.sh dev
# 另一个终端启动小程序 H5 预览
bash scripts/pnpm.sh --filter @home-chef/miniapp dev:h5
```
网页：http://localhost:5173
H5：http://localhost:10086

已有环境可以直接运行 dev，不必重新初始化。业务数据库为 home_chef_business；旧 home_chef 演示数据库保留，但当前应用不连接它。

## 新账号与服务者
1. 网页点击“注册新用户”；H5/小程序点击“没有账号，去注册”。
2. 填写账号、昵称、至少 10 位密码并确认密码。账号支持 3–40 位字母、数字和下划线。
3. 首页左上角地图选择服务位置；在地址页选址并补充门牌号保存。
4. 服务者提交真实自我介绍、菜系、接单出发位置、健康材料和协议确认。
5. 运营审核通过后，服务者发布实际套餐与未来档期，才会出现在搜索结果中。
6. 用户查看服务范围和评价，收藏、筛选、预约、获取服务器报价并提交订单。

没有已审核并开启接单的服务者时，首页会真实显示空列表。不会用示例人物填充。

## 当前付款状态
微信支付和原路退款的接入代码已实现，待配置商户资料并完成真机验证；厨师结算、微信提现和直接分账代码亦已接入，详见 [厨师资金配置](docs/chef-finance.md)；真实保险尚未接入。
提交订单保存为 **PENDING_PAYMENT / UNPAID**，实收为 0。微信验签确认收款后才记账并邀请厨师，不生成虚构保险保单。付款期限过后自动取消并释放报价档期；用户可主动取消。
业务模式的模拟付款、退款、结算和保险入口在服务端被禁止。不能将改名或写入数据库当成真实收款。

账户密码注册已可用；短信验证码、微信登录和第三方实名渠道未接入，页面不会将账号注册标为手机号/实名已认证。

## 运营账户与配置
初始化仅创建运营账户和服务规则，不创建顾客、服务者或交易示例。
运营用户名来自 .env 的 ADMIN_BOOTSTRAP_USERNAME（默认 operator）；密码来自 ADMIN_BOOTSTRAP_PASSWORD，由首次初始化生成。查看本机 .env 获取，不要上传该文件。
新增注册账号只获得普通用户权限，无法自行通过服务者审核。

地图 Key 配置、微信位置能力和真实联调状态见 [地图接入说明](docs/map-integration.md)。
关键配置：APP_MODE=business、DATABASE_URL、DATA_KEY、INTERNAL_JOB_SECRET、TENCENT_MAP_BROWSER_KEY、TENCENT_MAP_REFERER。
当前仍需真实微信 AppID、HTTPS 后端部署、合法域名和真机验收，才能作为可用微信体验版上传。

## 验证
```bash
bash scripts/pnpm.sh typecheck
bash scripts/pnpm.sh build
bash scripts/pnpm.sh --filter @home-chef/miniapp build:h5
bash scripts/test-integration.sh
bash scripts/pnpm.sh test:ui
```
test:ui 会检查并启动网页 5173 和 H5 10086，会创建/使用独立 home_chef_test 数据库，并临时启动 3001 测试 API；退出后停止该 API。它不在业务库里创建测试数据。
test:maps 使用同一隔离入口单独运行地图与动态片区验收。
测试覆盖两端注册、重新登录、搜索、菜系和排序、收藏增删、连续详情与锚点、订单提交、详情、下拉刷新和不同用户数据隔离。
历史模拟支付回归只在隔离测试环境执行。db:seed 默认只初始化业务规则；db:seed:demo 是显式历史测试工具，不能在 business 模式运行。

本轮实施与验收：[真实业务清理记录](docs/business-cleanup.md)。
原需求和历史实现记录仍保留在 docs 中；旧文档中的演示账号、模拟付款或试运营描述不代表当前环境。

日志字段、排查方式及完整验收边界见 [日志与功能验收](docs/logging-and-acceptance.md)。
