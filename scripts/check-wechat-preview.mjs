import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const problems=[];
const readJson=async p=>JSON.parse(await readFile(join(root,p),'utf8'));
let project;
try{project=await readJson('apps/miniapp/project.config.json')}catch{problems.push('找不到小程序项目配置。')}
if(project&&!/^wx[a-f0-9]{16}$/i.test(project.appid??''))problems.push('项目仍是游客AppID。请配置真实WECHAT_APP_ID后运行正式构建脚本。');
try{
 const config=await readJson('apps/miniapp/dist/project.config.json');
 if(!/^wx[a-f0-9]{16}$/i.test(config.appid??''))problems.push('dist产物仍是游客AppID，不能验收微信手机号登录。');
 if(project&&config.appid!==project.appid)problems.push('项目与dist的AppID不同，需要重新构建。');
 const dir=join(root,'apps/miniapp/dist');
 const files=(await readdir(dir,{recursive:true})).filter(p=>p.endsWith('.js'));
 const code=(await Promise.all(files.map(p=>readFile(join(dir,p),'utf8')))).join('\n').replace(/\\u([a-f0-9]{4})/gi,(_,x)=>String.fromCharCode(parseInt(x,16)));
 if(/https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/.test(code))problems.push('dist含本机回环接口地址，手机无法通过此地址访问你的电脑服务。请设置正式TARO_APP_API_BASE。');
 for(const label of ['返回首页','返回微信一键登录','微信登录未完成'])if(!code.includes(label))problems.push('dist缺少“'+label+'”，可能未包含最新修复。');
}catch{problems.push('无法完整读取dist；请先构建微信小程序。')}
console.log('检查对象：apps/miniapp 与 apps/miniapp/dist（未读取密钥）。');
if(problems.length){for(const p of problems)console.log('未通过：'+p);process.exitCode=1}
else console.log('本地包基础检查通过。仍需核对微信平台能力、服务端配置并进行真机登录验收。');
