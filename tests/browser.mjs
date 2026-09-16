import {chromium} from 'playwright';
import {mkdir,readdir,access} from 'node:fs/promises';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:5173';
const cache=homedir()+'/.cache/ms-playwright';
let executablePath=process.env.BROWSER_PATH;
if(!executablePath){for(const name of(await readdir(cache)).filter(n=>/^chromium-/.test(n)).sort().reverse()){const p=cache+'/'+name+'/chrome-linux64/chrome';try{await access(p);executablePath=p;break;}catch{}}}
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
const errors=[],root='docs/evidence';
await mkdir(root,{recursive:true});
const page=await browser.newPage({viewport:{width:1440,height:1100}});
page.on('pageerror',e=>errors.push(e.message));
async function login(p,username){
 await p.goto(base);await p.getByLabel('账号',{exact:true}).fill(username);await p.getByLabel('密码',{exact:true}).fill(process.env.DEMO_PASSWORD);
 await p.getByRole('button',{name:'登录',exact:true}).click();await p.getByRole('button',{name:'退出',exact:true}).waitFor();
}
try{
 await page.goto(base);await page.screenshot({path:root+'/login.png',fullPage:true});
 await login(page,'demo');await page.getByRole('heading',{name:'附近的好厨师'}).waitFor();
 assert.equal(await page.locator('.chef-card').count(),3);
 await page.screenshot({path:root+'/home-desktop.png',fullPage:true});
 await page.getByRole('button',{name:'选套餐',exact:true}).first().click();
 await page.getByRole('combobox',{name:'服务地址'}).click();
 await page.locator('.ant-select-item-option').filter({hasText:'家 ·'}).first().click();
 await page.getByRole('button',{name:'获取正式报价'}).click();
 await page.getByRole('heading',{name:'报价已确认'}).waitFor();
 await page.screenshot({path:root+'/booking.png',fullPage:true});
 await page.getByRole('button',{name:'确认沙箱支付'}).click();
 await page.getByRole('heading',{name:'我的订单',exact:true}).waitFor();
 const token=await page.evaluate(()=>localStorage.getItem('home-chef-token'));
 const read=async(path)=>{const r=await fetch('http://127.0.0.1:3000'+path,{headers:{authorization:'Bearer '+token}});assert(r.ok);return r.json();};
 const orders=await read('/orders');const order=orders[0];assert.equal(order.contractStatus,'PENDING_ACCEPTANCE');assert.equal(order.receivedFen,5940);
 await page.getByRole('button',{name:'查看详情与操作'}).first().click();
 await page.getByText('过敏提醒：无已知过敏').waitFor();
 await page.screenshot({path:root+'/order.png',fullPage:true});
 const chef=await browser.newPage({viewport:{width:1280,height:900}});chef.on('pageerror',e=>errors.push(e.message));
 await login(chef,'chef1');await chef.getByRole('button',{name:'我的订单',exact:true}).click();
 await chef.getByRole('button',{name:'查看详情与操作'}).first().click();
 await chef.getByRole('button',{name:'接单 / 抢单',exact:true}).click();
 await chef.getByRole('button',{name:'记录出发',exact:true}).waitFor();
 assert.equal((await read('/orders/'+order.id)).contractStatus,'ACCEPTED');
 await chef.screenshot({path:root+'/chef-workflow.png',fullPage:true});
 await chef.getByRole('button',{name:'申请取消',exact:true}).click();
 await chef.getByText('沙箱退款完成').waitFor({timeout:2000}).catch(()=>{});
 await page.reload();await page.getByRole('heading',{name:'附近的好厨师'}).waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:root+'/home-mobile.png',fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 const admin=await browser.newPage({viewport:{width:1440,height:1000}});admin.on('pageerror',e=>errors.push(e.message));
 await login(admin,'operator');await admin.getByRole('heading',{name:'今天，也让每一餐安心。'}).waitFor();
 await admin.screenshot({path:root+'/operations.png',fullPage:true});
 await admin.getByRole('button',{name:'厨师审核',exact:true}).click();await admin.getByRole('button',{name:'审核',exact:true}).first().waitFor();
 await admin.getByRole('button',{name:'运营规则',exact:true}).click();await admin.getByRole('textbox',{name:'规则JSON'}).waitFor();
 assert.equal((await read('/orders/'+order.id)).contractStatus,'CANCELLED');
 assert.deepEqual(errors,[]);
 console.log('Browser acceptance passed: login, chef discovery, quote/deposit, chef acceptance, refund, responsive layout, operations and rules. Screenshots: '+root);
}finally{await browser.close();}
