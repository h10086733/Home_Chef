import {chromium} from 'playwright';
import {readdir,access,mkdir} from 'node:fs/promises';import {homedir}from'node:os';import assert from'node:assert/strict';
const cache=homedir()+'/.cache/ms-playwright';let executablePath=process.env.BROWSER_PATH;
if(!executablePath)for(const name of(await readdir(cache)).filter(n=>/^chromium-/.test(n)).sort().reverse()){const p=cache+'/'+name+'/chrome-linux64/chrome';try{await access(p);executablePath=p;break;}catch{}}
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})}),page=await browser.newPage({viewport:{width:390,height:844}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:10086');await page.locator('input').first().fill('demo');await page.locator('input').nth(1).fill(process.env.DEMO_PASSWORD);
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('登录',{exact:true}).click();await page.getByText('附近的好厨师',{exact:true}).waitFor();
 await mkdir('docs/evidence',{recursive:true});await page.screenshot({path:'docs/evidence/miniapp-h5.png',fullPage:true});

 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('找人来做饭 →',{exact:true}).click();
 await page.locator('input[placeholder="搜索名字、菜系、拿手菜"]').fill('不存在的服务者');
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('暂时没有符合条件的服务者，试试其他名字或菜系。',{exact:true}).waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('清除',{exact:true}).click();
 await page.locator('.person-card').first().click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('服务者详情',{exact:true}).waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('手艺与评价',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('用户评价',{exact:true}).waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('服务套餐',{exact:true}).click();
 await page.screenshot({path:'docs/evidence/community-chef-detail.png',fullPage:true});
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('预约这份服务',{exact:true}).first().click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('下一步：用餐需求',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('下一步：确认费用',{exact:true}).click();
 await page.screenshot({path:'docs/evidence/community-booking.png',fullPage:true});
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('获取报价',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText(/沙箱支付30%定金/).waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('返回厨师列表',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('首页',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('家常套餐',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('选这个套餐',{exact:true}).first().waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('我的',{exact:true}).click();await page.getByText('优惠与消息',{exact:true}).waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('领取新人券',{exact:true}).click();await page.getByText(/新人家宴券/).first().waitFor();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('我也想做饭赚收入',{exact:true}).click();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('提交入驻审核',{exact:true}).waitFor();
 await page.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'}); await page.getByText('订单',{exact:true}).click();await page.getByText('我的订单',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);console.log('Taro H5 browser passed: login, chef discovery, search/empty state, chef detail, three-step booking/server quote, quote release, packages, account/coupon, provider entry, orders, 390px layout.');
}catch(e){console.log((await page.locator('body').innerText()).slice(0,2000));throw e;}finally{await browser.close();}