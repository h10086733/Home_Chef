# 微信手机号一键登录

更新：2026-09-18。代码接入和隔离测试已完成；真实 AppID、AppSecret、手机号能力及真机授权仍需配置与验收。

## 用户流程

小程序默认展示“微信手机号一键登录”。用户同意手机号用于本平台账号后，点击原生 getPhoneNumber 按钮；客户端取得手机号授权 code，再通过 Taro.login 取得登录 code。两种 code 不可互换，不直接提交或信任用户输入的手机号/OpenID/UID。

POST /api/auth/wechat/phone-login 接收 loginCode、phoneCode、consent。服务端经 jscode2session 获取 OpenID，经 stable_token 和 getuserphonenumber 获取微信验证的手机号，并核对返回数据的 AppID。登录不依赖支付商户配置。

平台 UID 是 User.id；同一 OpenID 登录返回同一个 UID。手机号授权仅证明当前号码的授权，不表示第三方实名认证或厨师身份审核已通过。

## 旧账号与冲突

已有网页或密码账号用户：在小程序选择“已有账号，登录后绑定”，进入“我的”授权手机号。服务端必须验证现有登录会话，绑定时保留 UID、订单和角色。不会仅凭传入 UID 或相同手机号合并账号、转移余额、授予角色。

微信或手机号已属于其他账号时拒绝绑定；同一微信已绑定不同手机号时禁止静默换绑。换号/注销/人工核验恢复流程尚未提供，不应通过直接改库绕过。

新建用户只有 USER 角色，用户名和密码可为空。网站/H5仍使用现有密码登录，不模拟微信手机号授权。旧账号入口仍保留以完成迁移。

## 存储与日志

User.phone 保存基于 DATA_KEY 的 HMAC 唯一检索值，新字段 phoneEncrypted 保存加密手机号，phoneVerifiedAt 保存验证时间。既有历史明文 phone 记录只用于冲突识别和本人绑定迁移；本次不批量改写历史数据。

响应只返回平台会话和公开用户资料（新增 phoneBound 布尔字段），不返回明文手机号、OpenID、微信 access_token、session_key 或 AppSecret。运行日志不记录请求正文/查询密钥，审计只写用户 ID 与验证完成标记。

DATA_KEY 兼具既有资料加密与手机号索引用途，不可随意重置；轮换需专门迁移方案。

## 配置与迁移

.env 中配置以下变量，不把值提交仓库：

```dotenv
WECHAT_LOGIN_ENABLED=false
WECHAT_APP_ID=
WECHAT_APP_SECRET=
```

完成真实配置后才将 WECHAT_LOGIN_ENABLED 改为 true。WECHAT_PAY_ENABLED 可继续为 false，登录不要求商户私钥。还需要真实小程序 AppID、正式 HTTPS 请求域名和微信后台手机号能力/隐私配置。

迁移：db/migrations/202609180001_wechat_phone_login，仅增加 phoneEncrypted、phoneVerifiedAt 两列。本机业务库已执行。其他环境加载正确数据库配置后运行 db:generate、db:migrate，再重启 API；先升级数据库再运行新服务。

## 验证

bash scripts/pnpm.sh test:auth 在 home_chef_test_wechat 隔离库使用受控微信响应，验证授权同意、UID稳定、并发登录、敏感信息不外泄、密文存储、重复code拒绝、AppID不匹配、手机号冲突、旧账号绑定与角色保持、微信错误不建账号。

与 test:wechat、test:integration、test:ui、test:maps 串行运行。代码测试不代表真实弹窗、微信接口权限或生产域名已经验证。

真机验收：新用户授权→再次登录UID相同→拒绝授权不登录→旧账号登录后绑定→角色/订单保留→冲突账号被拒绝。必须检查微信后台能力及调用额度；本次没有开通外部权限。

接口参考：[手机号组件](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)、[服务端手机号接口](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-info/phone-number/getPhoneNumber.html)。本次工具未能抓取官方页面，发布前应在微信后台按当前官方文档核对并完成真机联调。