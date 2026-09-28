import { chromium, request } from 'playwright';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import assert from 'node:assert/strict';

const origin = 'https://chushidao.com';
const file = '.data/online-batch-20260926.json';
if (!process.argv.includes('--execute')) {
  console.log('Plan: chushidao.com; 10 clearly labelled pending chef applications, 5 customers; at most 10 unpaid orders against existing eligible chefs. No approval/payment/dispatch. Run with --execute.');
  process.exit(0);
}
await mkdir('.data', {recursive:true});
let state;
try { state=JSON.parse(await readFile(file,'utf8')); }
catch(e) { if(e.code!=='ENOENT')throw e; state={origin,batch:'batch0926'+randomBytes(3).toString('hex'),createdAt:new Date().toISOString(),accounts:[],orders:[],attempts:[]}; }
assert.equal(state.origin,origin);
const save=async()=>{await writeFile(file,JSON.stringify(state,null,2),{mode:0o600});await chmod(file,0o600)};
await save();
const http=await request.newContext({baseURL:origin,timeout:25000});
const sessions=[];const loggedIn=new Map();
async function api(path, token, body) {
  const r=await http.fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:token?{authorization:'Bearer '+token}:{},...(body===undefined?{}:{data:body})});
  const data=await r.json();
  if(r.status()>=500)throw Error('Server failure at '+path+' HTTP '+r.status());
  return {status:r.status(),data};
}
function ok(r,label){if(r.status>=400)throw Error(label+': HTTP '+r.status+' '+(r.data.error?.code??''));return r.data}
async function account(kind,index){
  const key=kind+index;if(loggedIn.has(key))return loggedIn.get(key);
  let a=state.accounts.find(x=>x.kind===kind&&x.index===index);
  if(!a){a={kind,index,username:state.batch+kind+String(index).padStart(2,'0'),password:randomBytes(18).toString('base64url'),displayName:'测试勿预约·'+(kind==='chef'?'长沙厨师':'用户')+String(index).padStart(2,'0')};state.accounts.push(a);await save()}
  let r=await api(a.id?'/auth/login':'/auth/register',null,{username:a.username,password:a.password,displayName:a.displayName});
  if(!a.id&&r.status===409&&r.data.error?.code==='USERNAME_TAKEN')r=await api('/auth/login',null,{username:a.username,password:a.password});
  if(r.status===429){state.blockedAt=new Date().toISOString();state.blockedReason='RATE_LIMIT: wait at least 15 minutes before resuming';await save();throw Error(state.blockedReason)}
  const login=ok(r,'account');a.id=login.user.id;sessions.push(login.token);await save();const result={a,token:login.token};loggedIn.set(key,result);return result;
}
let browser;
try {
  const bootstrap=await account('user',1); const runtime=ok(await api('/runtime',bootstrap.token),'runtime');assert.equal(runtime.mode,'business');
  const rules=ok(await api('/rules',bootstrap.token),'rules');const region=rules.regions.find(r=>r.code==='CS-YL'&&r.active);assert(region,'Yuelu region must be active');
  const d=(await readdir(homedir()+'/.cache/ms-playwright')).filter(x=>/^chromium-/.test(x)).sort().reverse()[0];
  browser=await chromium.launch({headless:true,executablePath:homedir()+'/.cache/ms-playwright/'+d+'/chrome-linux64/chrome'});
  const card=await browser.newPage({viewport:{width:700,height:400}});
  await card.setContent('<body style="font:30px sans-serif;padding:30px;color:#900">BATCH TEST ONLY<br><br>NOT A HEALTH CERTIFICATE<br>INVALID EVIDENCE — DO NOT APPROVE<br><br>长沙批量测试材料 · 不得审核通过</body>');
  const png=(await card.screenshot()).toString('base64');await browser.close();browser=null;
  const cuisines=['湘菜','粤菜','川菜','家常菜','湘菜','粤菜','川菜','湘菜','家常菜','湘菜'];
  for(let i=1;i<=10;i++){
    const {a,token}=await account('chef',i);const existing=ok(await api('/chef/profile',token),'chef profile');
    if(existing){assert.equal(existing.status,'PENDING_REVIEW','Never alter reviewed profiles');a.chefId=existing.id}
    else{
      if(!a.assetId){a.assetId=ok(await api('/files',token,{mime:'image/png',base64:png}),'test card upload').id;await save()}
      const chef=ok(await api('/chef/profile',token,{bio:'批量功能测试，请勿预约。不提供真实服务；上传为无效测试卡，不是健康证，不得审核通过。测试菜系：'+cuisines[i-1],cuisines:[cuisines[i-1]],regionCode:region.code,latitude:28.181+(i%3)*.001,longitude:112.946+(i%4)*.001,coordinateSystem:'GCJ02',healthValidUntil:new Date(Date.now()+30*86400000).toISOString(),healthAssetId:a.assetId,agreement:true}),'chef application');
      assert.equal(chef.status,'PENDING_REVIEW');a.chefId=chef.id;
    }
    a.status='PENDING_REVIEW';await save();console.log(JSON.stringify({step:'pending_chef',index:i,username:a.username}));
  }
  const customers=[];
  for(let i=1;i<=5;i++){
    const session=await account('user',i),{a,token}=session;let addresses=ok(await api('/addresses',token),'addresses');
    if(!a.addressId)a.addressId=addresses.find(x=>x.label==='批量测试·勿上门')?.id;
    if(!a.addressId)a.addressId=ok(await api('/addresses',token,{label:'批量测试·勿上门',regionCode:region.code,latitude:28.181,longitude:112.946,coordinateSystem:'GCJ02',fullText:'长沙市岳麓区公共地图点附近；虚构测试地址，无真实门牌，请勿上门。'}),'test address').id;
    customers.push(session);await save();console.log(JSON.stringify({step:'customer',index:i,username:a.username}));
  }
  // Recover any previously accepted quote after an interrupted submit; submit is idempotent.
  for(const attempt of state.attempts.filter(x=>x.quoteId&&!state.orders.some(o=>o.quoteId===x.quoteId))){
    const owner=customers.find(x=>x.a.username===attempt.customerUsername);assert(owner);
    const r=await api('/quotes/'+attempt.quoteId+'/submit',owner.token,{});
    if(r.status>=400&&r.data.error?.code==='QUOTE_EXPIRED')continue;
    const order=ok(r,'recover unpaid submit');assert.equal(order.receivedFen,0);assert.equal(order.paymentStatus,'UNPAID');
    state.orders.push({id:order.id,quoteId:attempt.quoteId,customerUsername:owner.a.username,chefId:attempt.chefId,startsAt:attempt.startsAt,paymentDeadline:order.details.paymentDeadline,status:order.contractStatus,receivedFen:0});await save();
  }
  const chefs=ok(await api('/chefs?latitude=28.181&longitude=112.946&regionCode='+region.code,customers[0].token),'eligible chefs');
  assert(!chefs.some(c=>state.accounts.some(a=>a.chefId===c.id)),'Pending test chef leaked to public list');
  const eligible=chefs.filter(c=>['APPROVED','TRIAL'].includes(c.status)&&c.packages.length&&!String(c.name).includes('测试'));
  state.eligibleCount=eligible.length;console.log(JSON.stringify({step:'eligible_chefs',count:eligible.length}));
  // Bound probes to 7 future days, lunch/dinner, at most 2 eligible providers (28 requests).
  for(let day=2;day<=8&&state.orders.length<10;day++)for(const hour of [11,17])for(const chef of eligible.slice(0,2)){
    if(state.orders.length>=10)break;
    const localDay=new Date(Date.now()+day*86400000+8*3600000).toISOString().slice(0,10);
    const startsAt=new Date(localDay+'T'+String(hour).padStart(2,'0')+':00:00+08:00').toISOString();
    if(state.attempts.some(x=>x.chefId===chef.id&&x.startsAt===startsAt))continue;
    const {a,token}=customers[state.orders.length%customers.length];
    const q=await api('/quotes',token,{packageId:chef.packages[0].id,addressId:a.addressId,startsAt,hours:2,guests:4,children:0,elders:0,allergens:'测试数据：无已知过敏',kitchen:'测试订单，无需准备厨房，请勿上门',taste:'批量功能测试，不付款，不安排服务',cuisine:chef.cuisines[0],ingredientMode:'CUSTOMER',mode:'SELF',urgent:false});
    const attempt={chefId:chef.id,startsAt,http:q.status,code:q.data.error?.code};state.attempts.push(attempt);await save();
    if(q.status>=400){if(!['CHEF_UNAVAILABLE','CHEF_OUT_OF_RANGE','BOOKING_WINDOW'].includes(attempt.code))throw Error('Unexpected quote rejection '+attempt.code);continue}
    // Persist quote before submitting: a timeout can be recovered with the same quote id, never a new charge.
    attempt.quoteId=q.data.id;attempt.customerUsername=a.username;await save();
    const order=ok(await api('/quotes/'+q.data.id+'/submit',token,{}),'submit unpaid order');
    assert.equal(order.contractStatus,'PENDING_PAYMENT');assert.equal(order.paymentStatus,'UNPAID');assert.equal(order.receivedFen,0);
    state.orders.push({id:order.id,quoteId:q.data.id,customerUsername:a.username,chefId:chef.id,startsAt,paymentDeadline:order.details.paymentDeadline,status:order.contractStatus,receivedFen:0});await save();
    console.log(JSON.stringify({step:'unpaid_order',count:state.orders.length}));
  }
  delete state.blockedAt;delete state.blockedReason;state.completedAt=new Date().toISOString();state.paymentEnabled=runtime.paymentEnabled;await save();
  console.log(JSON.stringify({step:'summary',pendingChefs:state.accounts.filter(a=>a.chefId).length,customers:customers.length,unpaidOrders:state.orders.length,quoteAttempts:state.attempts.length,paymentRequests:0}));
} finally {
  if(browser)await browser.close();
  for(const token of sessions){try{await api('/auth/logout',token,{})}catch{}}
  await http.dispose();
}
