import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
process.loadEnvFile(root+'.env');
const appId=process.env.WECHAT_APP_ID,base=process.env.TARO_APP_API_BASE;
if(!/^wx[a-f0-9]{16}$/i.test(appId??''))throw new Error('请先在 .env 配置真实 WECHAT_APP_ID');
let url;try{url=new URL(base);}catch{throw new Error('请先在 .env 配置 TARO_APP_API_BASE');}
if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('TARO_APP_API_BASE 必须是正式 HTTPS API 地址');
const path=root+'apps/miniapp/project.config.json',project=JSON.parse(await readFile(path,'utf8'));
project.appid=appId;project.setting={...project.setting,urlCheck:true};
await writeFile(path,JSON.stringify(project,null,2)+'\n');
console.log('小程序 AppID 已配置，并启用合法域名检查。请重新构建微信小程序。');