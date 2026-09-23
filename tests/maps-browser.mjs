import {chromium} from 'playwright';
import {readdir,access,mkdir,readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import assert from 'node:assert/strict';
const cache=homedir()+'/.cache/ms-playwright';let executablePath=process.env.BROWSER_PATH;
if(!executablePath)for(const name of(await readdir(cache)).filter(n=>/^chromium-/.test(n)).sort().reverse()){const p=cache+'/'+name+'/chrome-linux64/chrome';try{await access(p);executablePath=p;break;}catch{}}
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
assert.equal(process.env.MAP_TEST_ISOLATED,'true','Run via isolated UI test harness');
const dataFixture=JSON.parse(await readFile('.data/business-fixture.json','utf8'));
const base='http://127.0.0.1:3001',created=[],errors=[];const mapUsername=dataFixture.prefix+'customer',mapPassword=dataFixture.password;
const auth=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:mapUsername,password:mapPassword})});
assert(auth.ok);const {token}=await auth.json();
async function request(path,body,method){const r=await fetch(base+path,{method:method??(body?'POST':'GET'),headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};}
const point={module:'locationPicker',poiname:'地图选址测试点',poiaddress:'湖南省长沙市岳麓区测试街道',latlng:{lat:28.193456,lng:112.961234}};
async function fixture(page,redirect=false){
 await page.route('**/api/**',async route=>{const u=new URL(route.request().url());const response=await route.fetch({url:base+u.pathname+u.search});await route.fulfill({response});});
 await page.route('**/api/maps/config',route=>route.fulfill({json:{enabled:true,key:'test-browser-key',referer:'home-chef-test'}}));
 const pickerUrl=redirect?'https://mapapi.qq.com/web/mapComponents/locationPicker/v/index.html*':'https://apis.map.qq.com/tools/locpicker?*';
 if(redirect)await page.route('https://apis.map.qq.com/tools/locpicker?*',route=>route.fulfill({contentType:'text/html',body:'<script>location.replace("https://mapapi.qq.com/web/mapComponents/locationPicker/v/index.html")</script>'}));
 await page.route(pickerUrl,route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><button id="bad">无效坐标</button><button id="select">选择测试点</button><script>document.querySelector("#select").onclick=()=>parent.postMessage('+JSON.stringify(point)+',"*");document.querySelector("#bad").onclick=()=>parent.postMessage('+JSON.stringify({...point,latlng:{lat:999,lng:112}})+',"*");</script>'}));
}
async function select(page){
 const dialog=page.getByRole('dialog',{name:'地图选址'});await dialog.waitFor();
 const confirm=page.getByRole('button',{name:'确认这个位置'});assert(await confirm.isDisabled());
 await page.evaluate(p=>window.dispatchEvent(new MessageEvent('message',{origin:'https://apis.map.qq.com',source:window,data:p})),point);
 assert(await confirm.isDisabled(),'messages from another window must be ignored');
 for(const origin of ['https://untrusted.example','https://mapapi.qq.com.untrusted.example','http://mapapi.qq.com']){
  await page.evaluate(({origin,point})=>window.dispatchEvent(new MessageEvent('message',{origin,source:document.querySelector('iframe[title="腾讯地图选点"]').contentWindow,data:point})),{origin,point});
  assert(await confirm.isDisabled(),'messages from untrusted origins must be ignored');
 }
 await page.frameLocator('iframe[title="腾讯地图选点"]').locator('#bad').click();assert(await confirm.isDisabled());
 await page.frameLocator('iframe[title="腾讯地图选点"]').locator('#select').click();
 await confirm.click();await dialog.waitFor({state:'hidden'});
}
const adminAuth=await fetch(base+'/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:dataFixture.prefix+'admin',password:mapPassword})});assert(adminAuth.ok);const adminToken=(await adminAuth.json()).token;
const originalRules=(await request('/rules')).data;
async function publish(regions){const response=await fetch(base+'/ops/rules',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+adminToken},body:JSON.stringify({...originalRules,regions,reason:'隔离地图回归测试'})});assert(response.ok);}
assert(!originalRules.regions.some(r=>r.code==='CS-YL'),'Fixture must not silently support the old hardcoded region');
try{
 const web=await browser.newPage({viewport:{width:1100,height:850}});web.on('pageerror',e=>errors.push(e.message));
 await fixture(web);await web.goto('http://127.0.0.1:5173');await web.evaluate(t=>localStorage.setItem('home-chef-token',t),token);await web.reload();
 await web.getByRole('button',{name:'服务地址',exact:true}).click();assert.equal(await web.getByText('纬度',{exact:true}).count(),0);
 const config=await request('/maps/config');assert.equal(config.status,200);await web.route('**/api/maps/config',route=>route.fulfill({json:{enabled:false}}));
 {await web.getByRole('button',{name:'地图选择服务地址',exact:true}).click();await web.getByText('地图尚未配置，请联系管理员启用腾讯地图后再添加地址。',{exact:true}).waitFor();assert(await web.getByRole('button',{name:'保存地址',exact:true}).isDisabled());}
 await fixture(web);await web.getByRole('button',{name:'地图选择服务地址',exact:true}).click();
 await web.getByRole('button',{name:'取消选址',exact:true}).click();assert(await web.getByRole('button',{name:'保存地址',exact:true}).isDisabled());
 await web.getByRole('button',{name:'地图选择服务地址',exact:true}).click();await select(web);
 await web.getByPlaceholder('例如：3栋2单元602室').fill('MAP-WEB-'+Date.now());
 await mkdir('docs/evidence',{recursive:true});await web.screenshot({path:'docs/evidence/map-web-fixture.png',fullPage:true});
 const saving=web.waitForResponse(r=>r.url().endsWith('/api/addresses')&&r.request().method()==='POST');
 await web.getByRole('button',{name:'保存地址',exact:true}).click();const response=await saving;assert(response.ok());created.push((await response.json()).id);
 await web.getByRole('button',{name:'发现私厨',exact:true}).click();
 await web.getByLabel('搜索服务者').fill(dataFixture.prefix);
 await web.getByRole('button',{name:'选套餐',exact:true}).first().click();
 const booking=web.getByRole('dialog').filter({hasText:'获取正式报价'});
 await booking.getByLabel('上门时间').fill(dataFixture.startsAt.slice(0,16));
 const previousTime=await booking.getByLabel('上门时间').inputValue();
 await booking.getByRole('button',{name:'地图新增服务地址',exact:true}).click();
 await booking.getByRole('button',{name:'地图选择服务地址',exact:true}).click();await select(web);
 await booking.getByPlaceholder('例如：3栋2单元602室').fill('BOOKING-MAP-TEST');
 const added=web.waitForResponse(r=>r.url().endsWith('/api/addresses')&&r.request().method()==='POST');
 await booking.getByRole('button',{name:'保存地址并选择',exact:true}).click();const addedResponse=await added;assert(addedResponse.ok());const bookedAddress=await addedResponse.json();created.push(bookedAddress.id);
 await booking.getByRole('button',{name:'获取正式报价',exact:true}).waitFor();
 await web.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='获取正式报价')?.disabled);
 assert.equal(await booking.getByLabel('上门时间').inputValue(),previousTime);
 assert((await request('/addresses')).data.some(a=>a.id===bookedAddress.id&&a.fullText.includes('BOOKING-MAP-TEST')));
 await booking.locator('.ant-modal-close').click();
 const mini=await browser.newPage({viewport:{width:390,height:844}});mini.on('pageerror',e=>errors.push(e.message));
 await fixture(mini,true);await mini.goto('http://127.0.0.1:10086');await mini.locator('input').first().fill(mapUsername);await mini.locator('input').nth(1).fill(mapPassword);await mini.getByText('登录',{exact:true}).click();
 await mini.getByText('附近的好厨师',{exact:true}).waitFor();await mini.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'});
 await mini.getByText('我的',{exact:true}).click();await mini.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'});
 assert.equal(await mini.getByText('纬度',{exact:true}).count(),0);await mini.getByText('地图选择服务地址',{exact:true}).click();await select(mini);
 await mini.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'});
 await mini.locator('.field').filter({hasText:'楼栋 / 单元 / 门牌号'}).locator('input').fill('MAP-MINI-'+Date.now());
 const savingMini=mini.waitForResponse(r=>r.url().endsWith('/api/addresses')&&r.request().method()==='POST');await mini.getByText('保存地址',{exact:true}).click();const responseMini=await savingMini;assert(responseMini.ok());created.push((await responseMini.json()).id);
 await mini.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'});await mini.screenshot({path:'docs/evidence/map-mini-fixture.png',fullPage:true});
 const rows=(await request('/addresses')).data;
 for(const id of created){const row=rows.find(a=>a.id===id);assert(row);assert.equal(row.regionCode,dataFixture.regionCode);assert.equal(Number(row.latitude),point.latlng.lat);assert.equal(Number(row.longitude),point.latlng.lng);assert(row.fullText.includes('MAP-'));assert(row.fullText.includes(point.poiname),row.fullText);}
 assert.equal((await request('/addresses',{label:'invalid',regionCode:dataFixture.regionCode,latitude:39.9,longitude:116.4,fullText:'范围外',coordinateSystem:'GCJ02'})).status,400);
 assert.equal((await request('/addresses',{label:'invalid',regionCode:dataFixture.regionCode,latitude:28.19,longitude:112.96,fullText:'坐标系错误',coordinateSystem:'WGS84'})).status,400);
 assert(await mini.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await publish(originalRules.regions.map(r=>({...r,active:false})));
 await mini.reload();await mini.getByText('附近的好厨师',{exact:true}).waitFor();await mini.getByText('正在处理…',{exact:true}).waitFor({state:'hidden'});await mini.getByText('我的',{exact:true}).click();await mini.getByText('暂无开放的服务片区',{exact:true}).waitFor();
 assert(await mini.getByText('保存地址',{exact:true}).evaluate(el=>el.getAttribute('disabled')!==null||el.classList.contains('weui-btn_disabled')));
 assert.equal((await request('/addresses',{label:'closed',regionCode:dataFixture.regionCode,latitude:28.19,longitude:112.96,fullText:'已关闭片区',coordinateSystem:'GCJ02'})).status,409);
 assert.deepEqual(errors,[]);console.log('PASS: website + Taro H5 map fixtures, disabled/unconfigured, cancellation, message origin/source validation, invalid coordinates, confirmed selection -> actual PostgreSQL persistence, service range and coordinate-system rejection, dynamic region persistence and closed-region rejection. Live Tencent/WeChat not tested.');
}finally{for(const id of created)await request('/addresses/'+id,undefined,'DELETE');await publish(originalRules.regions);await browser.close();}
