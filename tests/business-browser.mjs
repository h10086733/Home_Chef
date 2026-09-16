import {chromium} from 'playwright';import {readdir,readFile,access,mkdir}from'node:fs/promises';import{homedir}from'node:os';import assert from'node:assert/strict';
const fixture=JSON.parse(await readFile('.data/business-fixture.json','utf8'));const password=fixture.password,username=fixture.prefix+'ui'+Date.now().toString().slice(-5);
let executablePath;for(const n of(await readdir(homedir()+'/.cache/ms-playwright')).filter(n=>/^chromium-/.test(n)).sort().reverse()){const p=homedir()+'/.cache/ms-playwright/'+n+'/chrome-linux64/chrome';try{await access(p);executablePath=p;break;}catch{}}
const browser=await chromium.launch({headless:true,executablePath}),page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
async function proxy(p){await p.route('**/api/**',async route=>{const u=new URL(route.request().url());const response=await route.fetch({url:'http://127.0.0.1:3001'+u.pathname.replace(/^\/api/,'')+u.search});await route.fulfill({response});});}
async function idle(){await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'});}
const tokens=[];async function req(path,body,token=tokens[0]){const r=await fetch('http://127.0.0.1:3001'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+token},...(body?{body:JSON.stringify(body)}:{})});assert(r.ok,await r.clone().text());return r.json();}
try{
 await proxy(page);await page.goto('http://127.0.0.1:10086');
 await page.getByText('没有账号，去注册',{exact:true}).click();
 for(const[i,value]of[username,'新注册用户',password,password].entries())await page.locator('input').nth(i).fill(value);
 const authResponse=page.waitForResponse(r=>r.url().endsWith('/api/auth/register'));await page.getByText('注册并登录',{exact:true}).click();tokens.push((await(await authResponse).json()).token);
 await page.getByText('附近的好厨师',{exact:true}).waitFor();await idle();
 assert.equal(await page.getByText(/开发沙箱|试运营/).count(),0);
 await page.getByText('选择服务位置',{exact:false}).first().waitFor();
 await req('/addresses',{label:'家',regionCode:fixture.regionCode,latitude:28.194,longitude:112.961,fullText:'隔离测试库 UI 地址',coordinateSystem:'GCJ02'});
 await page.getByText('找人来做饭 →',{exact:true}).click();await idle();
 await page.locator('input[placeholder="搜索名字、菜系、拿手菜"]').fill(fixture.prefix);
 await page.waitForFunction(()=>document.querySelectorAll('.person-card').length===2);
 await page.getByText('全部菜系 ▾',{exact:true}).click();await page.getByText('川菜',{exact:true}).click();
 await page.getByText('暂时没有符合条件的服务者，试试其他位置、名字或菜系。',{exact:true}).waitFor();
 await page.getByText('川菜 ▾',{exact:true}).click();await page.getByText('湘菜',{exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.person-card').length===1);
 await page.getByText('湘菜 ▾',{exact:true}).click();await page.getByText('全部',{exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.person-card').length===2);
 await page.getByText('默认排序 ▾',{exact:true}).click();await page.getByText('价格从高到低',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.person-card .price')?.textContent?.includes('158'));
 await page.getByText('价格从高到低 ▾',{exact:true}).click();await page.getByText('价格从低到高',{exact:true}).click();await page.waitForFunction(()=>document.querySelector('.person-card .price')?.textContent?.includes('98'));
 await page.locator('.person-card').first().click();await idle();await page.getByText('用户评价',{exact:true}).waitFor();
 assert(await page.locator('#chef-services').isVisible());assert(await page.locator('#chef-about').isVisible());
 await page.getByText('手艺与评价',{exact:true}).click();await page.waitForFunction(()=>{const r=document.getElementById('chef-about').getBoundingClientRect();return r.top>=0&&r.bottom<innerHeight;});
 await page.getByText('收藏',{exact:true}).click();await idle();await page.getByText('已收藏 · 取消收藏',{exact:true}).waitFor();
 assert.equal((await req('/favorites')).length,1);
 await page.getByText('已收藏 · 取消收藏',{exact:true}).click();await idle();assert.equal((await req('/favorites')).length,0);
 await page.getByText('服务套餐',{exact:true}).click();await page.getByText('预约这份服务',{exact:true}).first().click();
 await page.getByText('下一步：用餐需求',{exact:true}).click();await page.getByText('下一步：确认费用',{exact:true}).click();await page.getByText('获取报价',{exact:true}).click();await idle();
 await page.getByText('提交订单',{exact:true}).click();await idle();await page.getByText('我的订单',{exact:true}).waitFor();
 assert.equal(await page.getByText('刷新',{exact:true}).count(),0);
 const orders=await req('/orders');assert.equal(orders.length,1);assert.equal(orders[0].contractStatus,'PENDING_PAYMENT');assert.equal(orders[0].receivedFen,0);
 await page.getByText('详情 →',{exact:true}).click();await idle();await page.getByText(/微信支付尚未开通，订单已保存/).waitFor();
 await page.getByText('返回订单',{exact:true}).click();await page.evaluate(()=>window.scrollTo(0,0));
 const refreshed=page.waitForResponse(r=>r.url().endsWith('/api/orders'));
 await page.evaluate(()=>{const el=document.querySelector('.page');for(const[type,y]of[['touchstart',50],['touchmove',145],['touchend',145]]){const t=new Touch({identifier:1,target:el,clientX:100,clientY:y});el.dispatchEvent(new TouchEvent(type,{bubbles:true,touches:type==='touchend'?[]:[t],changedTouches:[t]}));}});await refreshed;await idle();
 await mkdir('docs/evidence',{recursive:true});await page.screenshot({path:'docs/evidence/business-orders-test.png',fullPage:true});
 await page.getByText('我的',{exact:true}).click();await idle();await page.getByText('退出登录',{exact:true}).click();await page.getByText('没有账号，去注册',{exact:true}).waitFor();
 await page.locator('input').first().fill(username);await page.locator('input').nth(1).fill(password);await page.getByText('登录',{exact:true}).click();await page.getByText('附近的好厨师',{exact:true}).waitFor();await idle();
 const web=await browser.newPage({viewport:{width:1280,height:900}});web.setDefaultTimeout(15000);web.on('pageerror',e=>errors.push(e.message));await proxy(web);await web.goto('http://127.0.0.1:5173');await web.getByRole('button',{name:'注册新用户',exact:true}).click();
 await web.getByLabel('账号',{exact:true}).fill(username+'w');await web.locator('.field').filter({hasText:'昵称'}).locator('input').fill('网页新用户');await web.getByLabel('密码',{exact:true}).fill(password);await web.getByLabel('确认密码',{exact:true}).fill(password);await web.getByRole('button',{name:'注册并登录',exact:true}).click();await web.getByRole('button',{name:'退出',exact:true}).waitFor();
 await web.getByLabel('搜索服务者').fill(fixture.prefix);await web.waitForFunction(()=>document.querySelectorAll('.chef-card').length===2);
 await web.getByRole('button',{name:'我的订单',exact:true}).click();await web.getByText('还没有订单，去发现一位好厨师吧',{exact:true}).waitFor();assert.equal(await web.getByRole('button',{name:'刷新',exact:true}).count(),0);
 await web.getByRole('button',{name:'退出',exact:true}).click();await web.getByLabel('账号',{exact:true}).fill(username);await web.getByLabel('密码',{exact:true}).fill(password);await web.getByRole('button',{name:'登录',exact:true}).click();await web.getByRole('button',{name:'我的订单',exact:true}).click();await web.getByRole('button',{name:'详情 '+fixture.prefix+'湘菜套餐',exact:true}).click();await web.getByText('订单已保存，请在微信小程序中打开本订单付款；支付未开通时无法扣款，付款期限过后自动取消。',{exact:true}).waitFor();assert.deepEqual(errors,[]);console.log('PASS: both apps registration, real search/cuisine/sort, continuous detail and anchors, favorite add/remove, pending-payment submission, card detail, pull-to-refresh, relogin, separate-user empty orders. All test records are isolated.');
 await web.locator('.ant-modal-close').click();await web.getByRole('dialog').waitFor({state:'hidden',timeout:5000});
 await web.getByRole('button',{name:'退出',exact:true}).click();await web.getByLabel('账号',{exact:true}).fill(fixture.prefix+'admin');await web.getByLabel('密码',{exact:true}).fill(fixture.password);await web.getByRole('button',{name:'登录',exact:true}).click();await web.getByRole('button',{name:'结算提现',exact:true}).click();await web.getByRole('heading',{name:'厨师结算与提现',exact:true}).waitFor();await web.getByRole('heading',{name:'提现申请',exact:true}).waitFor();await web.getByRole('heading',{name:'微信分账任务',exact:true}).waitFor();await web.screenshot({path:'docs/evidence/chef-finance-admin.png',fullPage:true});
 await web.getByRole('button',{name:'退出',exact:true}).click();await web.getByLabel('账号',{exact:true}).fill(fixture.prefix+'chef0');await web.getByLabel('密码',{exact:true}).fill(fixture.password);await web.getByRole('button',{name:'登录',exact:true}).click();await web.getByRole('button',{name:'厨师工作台',exact:true}).click();await web.getByRole('heading',{name:'我的收入',exact:true}).waitFor();await web.getByText('请在微信小程序的厨师工作台绑定收款资料、申请提现和确认微信收款。',{exact:true}).waitFor();
 await page.getByText('我的',{exact:true}).click();await idle();await page.getByText('退出登录',{exact:true}).click();await page.getByText('没有账号，去注册',{exact:true}).waitFor();await page.locator('input').first().fill(fixture.prefix+'chef0');await page.locator('input').nth(1).fill(fixture.password);await page.getByText('登录',{exact:true}).click();await page.getByText('附近的好厨师',{exact:true}).waitFor();await idle();await page.getByText('我的',{exact:true}).click();await idle();await page.getByText('进入接单工作台',{exact:true}).click();await page.getByText('我的收入',{exact:true}).waitFor();await page.getByText('微信提现渠道尚未开通，余额会保留。',{exact:true}).waitFor();await page.screenshot({path:'docs/evidence/chef-income-h5.png',fullPage:true});assert.deepEqual(errors,[]);console.log('PASS: finance navigation, settlement/withdrawal tables, chef income on web/H5, unconfigured transfer is disabled.' );
 const fresh=await req('/auth/login',{username,password});await req('/orders/'+orders[0].id+'/cancel',{reason:'完成 UI 测试，取消未支付订单'},fresh.token);
}catch(e){console.error('CAUSE',e.stack);console.log((await page.locator('body').innerText()).slice(0,2200));throw e;}finally{await browser.close();}
