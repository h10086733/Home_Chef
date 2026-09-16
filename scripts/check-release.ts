import {PrismaClient} from '@prisma/client';
import {existsSync} from 'node:fs';
import {loadWechatConfig} from '../apps/api/src/wechat-pay';
import {ChefFinanceService} from '../apps/api/src/chef-finance';
async function main(){
try{process.loadEnvFile(process.env.RELEASE_ENV_FILE??'.env');}catch{console.error('FAIL: 无法读取部署配置文件');process.exit(1);}
let failures=0;
const check=(name:string,ok:unknown)=>{console.log(`${ok?'PASS':'FAIL'}: ${name}`);if(!ok)failures++;};
const publicUrl=(s:string|undefined)=>{try{const u=new URL(s??'');return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.hostname.includes('.')&&!/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname)&&!u.hostname.endsWith('.local')&&!u.hostname.endsWith('.example')&&!u.hostname.endsWith('.invalid')&&u.hostname!=='example.com'?u:null;}catch{return null;}};
check('Node 22.12+ / 22.x',Number(process.versions.node.split('.')[0])===22&&Number(process.versions.node.split('.')[1])>=12);
check('正式业务模式',process.env.NODE_ENV==='production'&&process.env.APP_MODE==='business');
check('API 仅监听本机',process.env.HOST==='127.0.0.1');
check('仅信任本机代理',process.env.TRUST_LOCAL_PROXY==='true');
check('数据加密密钥',/^[a-f0-9]{64}$/i.test(process.env.DATA_KEY??''));
check('内部任务密钥',/^[a-f0-9]{64}$/i.test(process.env.INTERNAL_JOB_SECRET??'')&&process.env.INTERNAL_JOB_SECRET!==process.env.DATA_KEY);
check('后台任务启用',process.env.WORKER_ENABLED==='true');
const api=publicUrl(process.env.TARO_APP_API_BASE),web=publicUrl(process.env.WEB_ORIGIN);
check('小程序正式 API 地址（/api，无尾斜杠）',api?.pathname==='/api');
check('网页正式 HTTPS 来源',web?.pathname==='/');
check('腾讯地图配置',process.env.TENCENT_MAP_BROWSER_KEY&&process.env.TENCENT_MAP_REFERER);
check('真实微信 AppID',/^wx[a-f0-9]{16}$/i.test(process.env.WECHAT_APP_ID??''));
check('真实微信支付已启用',process.env.WECHAT_PAY_ENABLED==='true');
const db=new PrismaClient();
try{
 let wxReady=false;
 try{const c=loadWechatConfig();wxReady=!!c&&c.notifyUrl===api?.origin+'/api/payments/wechat/notify';}catch{}
 check('支付密钥文件、证书和回调地址',wxReady);
 if(wxReady){try{const s=new ChefFinanceService(db);s.holdHours();if(process.env.WECHAT_TRANSFER_ENABLED==='true')s.transferConfig();else throw new Error();check('厨师余额提现通道配置',true);}catch{check('厨师余额提现通道配置',false);}}
 else check('厨师余额提现通道配置',false);
 if(process.env.WECHAT_PROFITSHARING_ENABLED==='true'){const ratio=Number(process.env.WECHAT_PROFITSHARING_MAX_RATIO);check('直接分账比例配置',ratio>0&&ratio<=1);}
 check('网页和 API 构建产物',existsSync('apps/admin-web/dist/index.html')&&existsSync('apps/api/dist/main.js')&&existsSync('apps/worker/dist/main.js'));
 if(!process.argv.includes('--config-only')){
  try{await db.$queryRaw`SELECT 1`;check('业务数据库连接',true);
   const pending=await db.$queryRaw<any[]>`SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL`;
   check('不存在未完成迁移',pending.length===0);
   await db.chefSettlement.count();await db.chefWithdrawal.count();check('资金数据表存在',true);
   check('已配置管理员',await db.user.count({where:{roles:{has:'ADMIN'}}})>0);
   check('已配置独立财务账号',await db.user.count({where:{roles:{has:'FINANCE'}}})>0);
   check('至少一名已审核厨师',await db.chef.count({where:{status:{in:['TRIAL','APPROVED']}}})>0);
   check('已发布服务规则',await db.platformRule.count()>0);
  }catch{check('业务数据库与迁移检查',false);}
 }
}finally{await db.$disconnect();}
console.log(`\n${failures?'尚不能进入真实付费试运营':'自动检查通过；仍需完成真机付款、退款、提现及人工验收'}（${failures} 项待处理）。本检查不发起支付、不修改业务数据、不验证商户实际权限。`);
process.exitCode=failures?1:0;
}
void main().catch(()=>{console.error('FAIL: 上线检查异常，请检查运行环境');process.exitCode=1;});
