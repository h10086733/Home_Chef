# 微信小程序真实支付接入

当前已实现普通商户 APIv3 接入代码，尚未配置真实小程序 AppID、商户号与密钥，尚未进行微信真机扣款和退款验证。默认支付关闭。腾讯地图 Key 与微信支付商户配置无关。

## 已实现

- 登录后的用户通过小程序 `Taro.login` 获取临时 code；后端向微信换取 OpenID 并绑定现有账号，不向前端返回 session_key。一个微信仅能绑定一个账号，已有绑定不能静默覆盖。
- 待支付订单选择定金或全款；最终费用确认后支付尾款。金额取自数据库，不接受前端金额。
- 微信预支付请求使用 RSA-SHA256 签名；微信响应验签后才使用，客户端使用 `Taro.requestPayment`。网页和 H5 提示到小程序付款。
- 公开回调 `/api/payments/wechat/notify` 校验原始请求体签名、时间戳、公钥编号，并以 APIv3 密钥解密。核对商户号、AppID、付款人、订单号和金额，数据库事务保证重复通知不重复入账。
- 回调未到达时，通过用户查单和后台 worker 查询微信状态补偿。客户端成功提示不直接改变支付状态。
- 付款确认后生成厨师邀请。取消/超时后才收到的款项会记录实收并排队原路退款，不继续派单。
- 取消和费用退差价生成持久化退款任务，worker 使用原退款单号重试；只在微信查询确认 SUCCESS 后记录退款流水与已退款金额。异常退款显示给用户并记录审计，需运营在商户平台处理；后台继续查询结果。
- 不生成虚构保单。当前未接入真实保险，业务模式没有虚构保单履约门槛。

## 开通与配置

1. 申请正式微信小程序和微信支付商户号，开通小程序支付权限并完成商户号与 AppID 绑定。
2. 在商户平台准备商户 API 证书序列号、商户私钥、32 字节 APIv3 密钥，以及微信支付公钥和公钥 ID。本实现使用微信支付公钥模式；暂不自动下载或轮换平台证书。
3. 私钥放在服务端安全目录，例如 WSL `/home/qiyun/.secrets/wechat/apiclient_key.pem`，仅服务进程可读；不要上传到小程序或发送到聊天中。仓库已忽略 `.secrets/`、`*.pem`、`*.p12`。
4. 在根目录 `.env` 按 `.env.example` 填写：

```dotenv
WECHAT_PAY_ENABLED=false
WECHAT_APP_ID=正式小程序AppID
WECHAT_APP_SECRET=小程序AppSecret
WECHAT_MCH_ID=商户号
WECHAT_MCH_SERIAL=商户API证书序列号
WECHAT_MCH_PRIVATE_KEY_PATH=/绝对路径/apiclient_key.pem
WECHAT_API_V3_KEY=32字节APIv3密钥
WECHAT_PAY_PUBLIC_KEY_ID=PUB_KEY_ID_开头的微信支付公钥编号
WECHAT_PAY_PUBLIC_KEY_PATH=/绝对路径/wechatpay_public_key.pem
WECHAT_PAY_NOTIFY_URL=https://你的API域名/api/payments/wechat/notify
TARO_APP_API_BASE=https://你的API域名/api
```

5. 部署公网 HTTPS API，反向代理必须保留回调原文；配置小程序 request 合法域名为 API 域名，在微信后台配置 AppSecret 调用所需 IP 白名单。服务端允许访问 `api.weixin.qq.com` 和 `api.mch.weixin.qq.com`。服务器校准时间。
6. 在 WSL 运行 `bash scripts/build-wechat.sh`。脚本将实际 AppID 写入小程序工程并启用合法域名校验，编译时仅把公开 API 地址写入小程序。缺少 AppID/HTTPS 地址会拒绝构建发布包。
7. 完成配置后将 `WECHAT_PAY_ENABLED=true`，重启 API 与 worker。配置缺失或密钥格式不正确时 API 启动失败，避免半配置收款。微信公钥变更时替换公钥文件与编号后重启。
8. 微信开发者工具导入 `apps/miniapp`，真机验证：注册账号、选择地址和厨师、提交订单、支付定金、确认到账、取消订单、确认原路退款。必须核对微信商户平台和数据库金额；还需验证全款及尾款。

## 后台任务与运维

必须持续运行 worker：它调用认证保护的 `/internal/tick`，补查支付、关单及处理退款。重启不会丢失任务，任务存于 PaymentRequest。每轮最多处理 5 笔，网络失败保留待处理状态；异常退款按至少 5 分钟间隔复查。小规模 MVP 使用此调度，规模增长需队列并发、告警和账单日对账。

收款进入配置的商户账户。厨师结算、余额提现和微信直接分账接入代码现已补齐，见 [厨师资金接入说明](chef-finance.md)。真实出款仍待开通相应权限并完成真机验证。采购预算增额现已接入微信支付：厨师提交新采购总预算，顾客在小程序点击“同意并微信支付补款”；服务器按变更记录计算差额，并绑定 changeId。只有验签确认到账才增加订单总额、实收和采购预算，原尾款保持不变。退出收银台不代表拒绝变更，可继续支付或拒绝；拒绝后未支付单自动关单，迟到到账或重复收款按对应支付单原路退款。网页/H5 提示到小程序付款。补款过期后，原请求关单确认完成才能重新发起。上线前需另行完成相应运营流程，不能把订单结算状态视为已向厨师打款。

## 自动化验证

运行 `bash scripts/pnpm.sh test:wechat`。数据库固定为 `home_chef_test_wechat`，使用测试生成的 RSA 密钥及签名传输夹具，不访问微信收费接口、不产生真实扣款。覆盖账号绑定、服务端金额、权限、重复预支付、签名防篡改、真实 HTTP 原文验签、重复通知、退款确认、取消后到账、网络丢失补查、关单和尾款。

另运行 `bash scripts/pnpm.sh typecheck`、`bash scripts/pnpm.sh build` 和 `bash scripts/pnpm.sh test:ui`。

官方依据：[小程序下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791897)、[小程序调起支付](https://pay.wechatpay.cn/doc/v3/merchant/4012791898)、[支付回调](https://pay.wechatpay.cn/doc/v3/merchant/4012791902)、[退款申请](https://pay.wechatpay.cn/doc/v3/merchant/4012791903)。