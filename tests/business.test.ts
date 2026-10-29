import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {PrismaClient} from '@prisma/client';
import {MvpService} from '../apps/api/src/support';
import {hashPassword} from '../apps/api/src/security';
assert(process.env.DATABASE_URL?.includes('/home_chef_test'),'Only isolated test database');
process.env.APP_MODE='business';
const db=new PrismaClient(),prefix='real'+randomUUID().replaceAll('-','').slice(0,8),password='BusinessTest2026!';
let now=new Date();const svc=new MvpService(db,()=>now),users:any[]=[];
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
after(()=>db.$disconnect());
test('Real-data business flow',async t=>{
 const admin=await db.user.create({data:{username:prefix+'admin',displayName:'测试审核员',roles:['ADMIN','REVIEWER','FINANCE'],passwordHash:hashPassword(password)}});
 await db.platformRule.create({data:{id:prefix+'rules',publishedBy:admin.id,data:{commissionRate:.15,matchMinutes:10,radiusM:3000,urgentMinMinutes:30,couponFen:2000,couponMinFen:20000,couponEnabled:false,regions:[{code:prefix,name:'测试专用区域',active:true}]}}});
 await t.test('registration, duplicate, password, session isolation',async()=>{
  for(const suffix of ['customer','stranger','chef0','chef1']){const a=await svc.login({username:prefix+suffix,password,displayName:prefix+suffix,agreed:true},true);users.push(await svc.session(a.token));}
  await assert.rejects(()=>svc.login({username:users[0].username,password,displayName:'重复',agreed:true},true),/账号已存在/);
  await assert.rejects(()=>svc.login({username:users[0].username,password:'wrong'}),/账号或密码不正确/);
  await assert.rejects(()=>svc.login({username:prefix+'skip',password,displayName:'未同意',agreed:false},true),/协议/);
  await assert.rejects(()=>svc.login({username:prefix+'weak',password:'short',displayName:'弱密码',agreed:true},true),/至少10位/);
  await assert.rejects(()=>svc.login({username:'a',password,displayName:'过短',agreed:true},true),/3至40位/);
  const auth=await svc.login({username:users[0].username,password});assert.equal((await svc.session(auth.token)).id,users[0].id);await svc.logout(auth.token);await assert.rejects(()=>svc.session(auth.token));
  assert.deepEqual(await svc.orders(users[1]),[]);assert.deepEqual(await svc.addresses(users[1]),[]);
 });
 await t.test('five wrong passwords lock the account until the cooling period ends',async()=>{
  const name=prefix+'lock';
  await svc.login({username:name,password,displayName:'锁定测试',agreed:true},true);
  for(let i=0;i<5;i++)await assert.rejects(()=>svc.login({username:name,password:'wrong-password'}),/不正确/);
  await assert.rejects(()=>svc.login({username:name,password}),/30 分钟/);
  const previous=now;now=new Date(now.getTime()+31*60000);
  try{assert.equal((await svc.session((await svc.login({username:name,password})).token)).username,name);}finally{now=previous;}
 });
 await t.test('deletion request ends the session and logging in cancels it',async()=>{
  await assert.rejects(()=>svc.requestDeletion(users[1],{}),/确认/);
  const requested=await svc.requestDeletion(users[1],{confirm:true});
  assert.equal(new Date(requested.effectiveAt).getTime()-now.getTime(),15*86400000);
  await assert.rejects(()=>svc.requestDeletion(admin,{confirm:true}),/工作人员/);
  const back=await svc.login({username:users[1].username,password});users[1]=await svc.session(back.token);
  assert.equal((await db.user.findUniqueOrThrow({where:{id:users[1].id}})).deletionRequestedAt,null);
 });
 const chefs:any[]=[],packages:any[]=[];
 await t.test('registered providers submit evidence, review, publish packages and schedules',async()=>{
  for(let i=0;i<2;i++){const file=await svc.upload(users[i+2],{base64:png,mime:'image/png'});const chef=await svc.applyChef(users[i+2],{bio:prefix+'拿手家常菜'+i,cuisines:[i?'粤菜':'湘菜'],regionCode:prefix,latitude:28.194+i*.001,longitude:112.961,healthValidUntil:new Date(now.getTime()+365*86400000).toISOString(),healthAssetId:file.id,agreement:true,coordinateSystem:'GCJ02'});
   assert.equal(chef.status,'PENDING_REVIEW');await assert.rejects(()=>svc.savePackage(users[i+2],{name:'未审核',description:'不允许',serviceFen:10000}));
   await svc.auditChef(admin,chef.id,{status:'TRIAL',reason:'仅测试库完整流程验证',checks:['identity','health','skill','conduct']});
   const pkg=await svc.savePackage(users[i+2],{name:prefix+(i?'粤菜套餐':'湘菜套餐'),description:'备菜做饭和基础清理',serviceFen:i?15800:9800});
   await svc.saveSchedule(users[i+2],{startsAt:new Date(now.getTime()+86400000).toISOString(),endsAt:new Date(now.getTime()+20*86400000).toISOString()});chefs.push(chef);packages.push(pkg);
  }
 });
 await t.test('schedule validation explains past, reversed, invalid and overlong times',async()=>{
  const future=new Date(now.getTime()+86400000).toISOString();
  await assert.rejects(()=>svc.saveSchedule(users[2],{startsAt:'invalid',endsAt:future}),/请选择有效/);
  await assert.rejects(()=>svc.saveSchedule(users[2],{startsAt:new Date(now.getTime()-60000).toISOString(),endsAt:future}),/必须晚于当前时间/);
  await assert.rejects(()=>svc.saveSchedule(users[2],{startsAt:future,endsAt:future}),/结束时间必须晚于开始时间/);
  await assert.rejects(()=>svc.saveSchedule(users[2],{startsAt:future,endsAt:new Date(now.getTime()+33*86400000).toISOString()}),/不能超过31天/);
 });
 await t.test('open schedules list bookable times inside the published slot',async()=>{
  const slotStart=now.getTime()+86400000;
  const rows=await svc.openSchedules(chefs[0].id,2);
  assert.ok(rows.times.length>0&&rows.times.length<=96);
  const first=new Date(rows.times[0]).getTime();
  assert.ok(first>=slotStart+3600000);
  assert.equal(rows.times.some(item=>new Date(item).getTime()<slotStart),false);
  assert.equal(rows.times.every(item=>['00','30'].includes(new Date(new Date(item).getTime()+8*3600000).toISOString().slice(14,16))),true);
  await assert.rejects(()=>svc.openSchedules('missing-chef',2),/厨师不存在/);
 });
 await t.test('database search, cuisine, price and geographic filters change results',async()=>{
  assert.equal((await svc.chefs({search:prefix})).length,2);
  assert.deepEqual((await svc.chefs({search:prefix,cuisine:'湘菜'})).map(c=>c.id),[chefs[0].id]);
  assert.equal((await svc.chefs({search:prefix,cuisine:'川菜'})).length,0);
  assert.equal((await svc.chefs({search:prefix,sort:'price_asc'}))[0].id,chefs[0].id);
  assert.equal((await svc.chefs({search:prefix,sort:'price_desc'}))[0].id,chefs[1].id);
  assert.equal((await svc.chefs({search:prefix,latitude:28.5,longitude:113.5})).length,0);
  assert.equal((await svc.chefs({search:prefix}))[0].rating,null);
 });
 await t.test('discovery uses booking radius and excludes closed or different regions',async()=>{
  const rule=await db.platformRule.findUniqueOrThrow({where:{id:prefix+'rules'}}),data=rule.data as any;
  await db.chef.update({where:{id:chefs[0].id},data:{serviceRadiusM:10000}});
  try{
   assert.equal((await svc.chefs({search:prefix,latitude:28.45,longitude:112.961})).length,0);
   assert.equal((await svc.chefs({search:prefix,latitude:28.194,longitude:112.961,regionCode:'other'})).length,0);
   assert.equal((await svc.chefs({search:prefix,latitude:28.194,longitude:112.961,regionCode:prefix})).length,2);
   await db.platformRule.update({where:{id:rule.id},data:{data:{...data,regions:data.regions.map((v:any)=>({...v,active:false}))}}});
   assert.equal((await svc.chefs({search:prefix})).length,0);
  }finally{await db.platformRule.update({where:{id:rule.id},data:{data}});await db.chef.update({where:{id:chefs[0].id},data:{serviceRadiusM:chefs[0].serviceRadiusM}});}
 });
 await t.test('favorites persist across login and can be removed',async()=>{
  assert.equal((await svc.favorites(users[0],chefs[0].id) as any).favorite,true);
  const auth=await svc.login({username:users[0].username,password});assert.equal((await svc.favorites(await svc.session(auth.token)) as any[]).length,1);
  assert.deepEqual(await svc.favorites(users[1]),[]);
  assert.equal((await svc.favorites(users[0],chefs[0].id) as any).favorite,false);assert.deepEqual(await svc.favorites(users[0]),[]);
 });
 const addr=await svc.address(users[0],{label:'测试用家',regionCode:prefix,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'只用于隔离库的测试地址'});
 const startsAt=new Date(now.getTime()+4*86400000);startsAt.setHours(18,0,0,0);
 const input={packageId:packages[0].id,addressId:addr.id,startsAt:startsAt.toISOString(),guests:3,children:0,elders:0,allergens:'无',kitchen:'灶台可用',cuisine:'湘菜',ingredientMode:'CUSTOMER',mode:'SELF',hours:2};
 await t.test('fifteen kilometer range quotes across districts and rejects farther or invalid bookings',async()=>{
  const here=await svc.chefs({search:prefix,latitude:28.194,longitude:112.961}),shown=here.find(c=>c.id===chefs[0].id);
  assert.equal(shown?.serviceRadiusM,15000);
  for(const key of ['latitude','longitude','phone','userId','data'])assert.equal(Object.hasOwn(shown??{},key),false);
  const nearLat=28.194+8000/111320,seen=await svc.chefs({search:prefix,latitude:nearLat,longitude:112.961});
  const nearby=seen.find(c=>c.id===chefs[0].id);assert.ok(nearby&&nearby.distanceM>7000&&nearby.distanceM<9000);
  assert.equal((await svc.chefs({search:prefix,latitude:28.45,longitude:112.961})).length,0);
  await assert.rejects(()=>svc.chefs({search:prefix,sort:'rating'}),/排序方式无效/);
  const rule=await db.platformRule.findUniqueOrThrow({where:{id:prefix+'rules'}}),data=rule.data as any,other=prefix+'-other';
  await db.platformRule.update({where:{id:rule.id},data:{data:{...data,regions:[...data.regions,{code:other,name:'另一开放片区',active:true}]}}});
  try{
   assert.equal((await svc.chefs({search:prefix,latitude:28.194,longitude:112.961,regionCode:other})).length,0);
   const near=await svc.address(users[0],{label:'另一片区',regionCode:other,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'片区代码不同、坐标相同'});
   const quote=await svc.quote(users[0],{...input,addressId:near.id});
   assert.equal(quote.chefId,chefs[0].id);assert.equal(quote.details.radiusM,15000);assert.equal(quote.sandbox,undefined);
   await svc.cancelQuote(users[0],quote.id);
   const far=await svc.address(users[0],{label:'超出范围',regionCode:other,latitude:28.45,longitude:112.961,coordinateSystem:'GCJ02',fullText:'超出15公里'});
   await assert.rejects(()=>svc.quote(users[0],{...input,addressId:far.id}),/不服务所选地址/);
   const odd=new Date(startsAt.getTime());odd.setMinutes(10);
   await assert.rejects(()=>svc.quote(users[0],{...input,startsAt:odd.toISOString()}),/整点或半点/);
   const soon=new Date(now.getTime()+2*3600000);soon.setMinutes(0,0,0);
   await assert.rejects(()=>svc.quote(users[0],{...input,startsAt:soon.toISOString()}),/提前24小时/);
   await assert.rejects(()=>svc.quote(users[0],{...input,ingredientMode:'DELIVERY'}),/食材方式/);
   await assert.rejects(()=>svc.quote(users[1],{...input,addressId:addr.id}),/本人地址/);
  }finally{await db.platformRule.update({where:{id:rule.id},data:{data}});}
  await assert.rejects(()=>svc.address(users[0],{label:'关闭片区',regionCode:'closed-zone',latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'未开放片区'}),/暂未开放/);
 });
 await t.test('paused chef and expired health certificate disappear from discovery',async()=>{
  await svc.manageChef(admin,chefs[1].id,{action:'SUSPENDED',reason:'隔离测试暂停接单'});
  try{
   assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===chefs[1].id),false);
   await assert.rejects(()=>svc.quote(users[0],{...input,packageId:packages[1].id}),/不可预约/);
  }finally{await svc.manageChef(admin,chefs[1].id,{action:'RESTORE',reason:'隔离测试恢复接单'});}
  assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===chefs[1].id),true);
  const health=(await db.chef.findUniqueOrThrow({where:{id:chefs[1].id}})).healthValidUntil;
  await db.chef.update({where:{id:chefs[1].id},data:{healthValidUntil:new Date(now.getTime()-1000)}});
  try{assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===chefs[1].id),false);}
  finally{await db.chef.update({where:{id:chefs[1].id},data:{healthValidUntil:health}});}
  assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===chefs[1].id),true);
 });
 await t.test('customer cannot open the ops dashboard, and a freeze ends the session',async()=>{
  assert.equal((await svc.dashboard(admin)).sandbox,false);
  await assert.rejects(()=>svc.dashboard(users[0]),/无权/);
  const auth=await svc.login({username:users[1].username,password});
  await svc.manageUser(admin,users[1].id,{action:'freeze',reason:'隔离测试冻结'});
  await assert.rejects(()=>svc.session(auth.token),/过期|冻结/);
  await assert.rejects(()=>svc.login({username:users[1].username,password}),/冻结/);
  await svc.manageUser(admin,users[1].id,{action:'restore',reason:'隔离测试恢复'});
  users[1]=await svc.session((await svc.login({username:users[1].username,password})).token);
 });
 await t.test('an unpaid order blocks account deletion until it is cancelled',async()=>{
  const home=await svc.address(users[1],{label:'陌生人的家',regionCode:prefix,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'隔离库地址'});
  const later=new Date(startsAt.getTime()+86400000);
  const quote=await svc.quote(users[1],{...input,addressId:home.id,startsAt:later.toISOString()}),order=await svc.submitQuote(users[1],quote.id);
  await assert.rejects(()=>svc.requestDeletion(users[1],{confirm:true}),/进行中的订单/);
  const preview=await svc.cancelPreview(users[1],order.id);assert.equal(preview.tier,'FREE');assert.equal(preview.refundFen,0);
  await svc.cancel(users[1],order.id,{reason:'测试取消未支付订单'});
  await assert.rejects(()=>svc.deleteAddress(users[1],home.id),/不可删除/);
 });
 await t.test('placing an order uses the server price and stays hidden from the chef',async()=>{
  const when=new Date(startsAt.getTime()+2*86400000).toISOString();
  const quote=await svc.quote(users[0],{...input,startsAt:when,totalFen:1,depositFen:1});
  assert.equal(quote.totalFen,9800);assert.equal(quote.depositFen,2940);assert.equal(quote.balanceFen,6860);assert.equal(quote.details.serviceFen,9800);assert.equal(quote.details.ingredientFen,0);
  await assert.rejects(()=>svc.quote(users[0],{...input,startsAt:when}),/不可预约/);
  const order=await svc.submitQuote(users[0],quote.id);
  try{
   assert.equal(order.contractStatus,'PENDING_PAYMENT');assert.equal(order.paymentStatus,'UNPAID');assert.equal(order.receivedFen,0);assert.equal(order.refundedFen,0);assert.equal(order.totalFen,9800);assert.equal(order.balanceFen,9800);assert.equal(order.sandbox,false);
   assert.equal(order.details.fullAddress,'只用于隔离库的测试地址');assert.equal(order.details.latitude,undefined);assert.equal(order.details.encryptedAddress,undefined);
   assert.ok(Math.abs(new Date(order.details.paymentDeadline).getTime()-now.getTime()-30*60000)<5000);
   assert.equal((await svc.orders(users[0])).some(o=>o.id===order.id&&o.contractStatus==='PENDING_PAYMENT'&&o.receivedFen===0),true);
   assert.equal((await svc.orders(users[2])).some(o=>o.id===order.id),false);assert.equal((await svc.orders(users[1])).some(o=>o.id===order.id),false);
   await assert.rejects(()=>svc.getOrder(users[2],order.id),/无权/);await assert.rejects(()=>svc.accept(users[2],order.id),/无权/);
   await assert.rejects(()=>svc.payQuote(users[0],quote.id,{paymentChoice:'FULL_PAYMENT',idempotencyKey:randomUUID()}),/尚未开通/);
   const other=await svc.address(users[1],{label:'同时段',regionCode:prefix,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'另一客户'});
   await assert.rejects(()=>svc.quote(users[1],{...input,addressId:other.id,startsAt:when}),/不可预约/);
  }finally{await svc.cancel(users[0],order.id,{reason:'测试结束释放档期'});}
  const released=await svc.quote(users[0],{...input,startsAt:when});await svc.cancelQuote(users[0],released.id);
 });
 await t.test('order placement rejects party size, overlap, a withdrawn quote and an expired quote',async()=>{
  const when=new Date(startsAt.getTime()+3*86400000).toISOString(),slot={...input,packageId:packages[1].id,startsAt:when,cuisine:'粤菜'};
  await assert.rejects(()=>svc.quote(users[0],{...input,startsAt:when,children:2,elders:2}),/不能超过用餐人数/);
  await assert.rejects(()=>svc.quote(users[0],{...input,startsAt:when,allergens:''}),/过敏信息/);
  await assert.rejects(()=>svc.quote(users[0],{...slot,hours:0}),/服务时长/);
  await assert.rejects(()=>svc.quote(users[0],{...slot,hours:9}),/服务时长/);
  const bought=await svc.quote(users[0],{...slot,ingredientMode:'CHEF',ingredientFen:5000});
  assert.equal(bought.totalFen,20800);assert.equal(bought.depositFen,6240);assert.equal(bought.details.ingredientFen,5000);
  await assert.rejects(()=>svc.quote(users[0],slot),/不可预约/);
  await svc.cancelQuote(users[0],bought.id);await assert.rejects(()=>svc.submitQuote(users[0],bought.id),/报价已过期/);
  const fresh=await svc.quote(users[0],slot),previous=now;now=new Date(now.getTime()+31*60000);
  try{await assert.rejects(()=>svc.submitQuote(users[0],fresh.id),/报价已过期/);}finally{now=previous;}
  await svc.cancelQuote(users[0],fresh.id);
 });
 await t.test('uploads stay private, rejected chefs can reapply, and certificates need another reviewer',async()=>{
  await assert.rejects(()=>svc.upload(users[0],{mime:'image/svg+xml',base64:Buffer.from('<svg></svg>').toString('base64')}),/PNG、JPEG、WebP、GIF、AVIF/);
  await assert.rejects(()=>svc.upload(users[0],{mime:'image/png',base64:Buffer.from('not-a-png!!').toString('base64')}),/PNG、JPEG、WebP、GIF、AVIF/);
  await assert.rejects(()=>svc.upload(users[0],{base64:Buffer.from([255,216,255]).toString('base64')}),/图片内容不完整/);
  const gif=Buffer.from('GIF89a\x00\x00\x00').toString('base64'),webp=Buffer.from('RIFF\x00\x00\x00\x00WEBP').toString('base64'),avif=Buffer.from('\x00\x00\x00\x20ftypmif1avif').toString('base64');
  assert.equal((await svc.upload(users[0],{mime:'image/jpeg',base64:gif})).mime,'image/gif');
  assert.equal((await svc.upload(users[0],{mime:'image/webp',base64:webp})).mime,'image/webp');
  assert.equal((await svc.upload(users[0],{mime:'image/jpeg',base64:avif})).mime,'image/avif');
  assert.equal((await svc.upload(users[0],{mime:'image/jpg',base64:Buffer.from([255,216,255,0,0,0,0,0,0]).toString('base64')})).mime,'image/jpeg');
  assert.equal((await svc.upload(users[0],{mime:'image/jpeg',base64:png.slice(0,8)+'\n'+png.slice(8)})).mime,'image/png');
  const jpeg=Buffer.from([255,216,255,0,0,0,0,0,0]).toString('base64'),image=await svc.upload(users[0],{mime:'image/jpeg',base64:jpeg});
  assert.equal(image.mime,'image/jpeg');assert.equal(Object.hasOwn(image,'bytes'),false);
  assert.equal((await svc.file(users[0],image.id)).mime,'image/jpeg');
  await assert.rejects(()=>svc.file(users[1],image.id),/无权/);
  const evidence=await svc.upload(users[2],{mime:'image/png',base64:png});
  assert.equal((await svc.file(admin,evidence.id)).userId,users[2].id);
  await assert.rejects(()=>svc.file(users[0],evidence.id),/无权/);
  await assert.rejects(()=>svc.applyChef(users[2],{bio:'重复入驻',cuisines:['湘菜'],regionCode:prefix,latitude:28.194,longitude:112.961,healthValidUntil:new Date(now.getTime()+400*86400000).toISOString(),healthAssetId:evidence.id,agreement:true,coordinateSystem:'GCJ02'}),/已入驻/);
  const applicantAuth=await svc.login({username:prefix+'redo',password,displayName:'重提测试',agreed:true},true),applicant=await svc.session(applicantAuth.token);
  const application=await svc.applyChef(applicant,{bio:prefix+'待驳回',cuisines:['湘菜'],regionCode:prefix,latitude:28.2,longitude:112.97,healthValidUntil:new Date(now.getTime()+400*86400000).toISOString(),healthAssetId:(await svc.upload(applicant,{mime:'image/png',base64:png})).id,agreement:true,coordinateSystem:'GCJ02'});
  await svc.auditChef(admin,application.id,{status:'REJECTED',reason:'材料不完整'});
  assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===application.id),false);
  await assert.rejects(()=>svc.savePackage(applicant,{name:'未通过',description:'不能发布',serviceFen:10000}),/审核通过/);
  assert.equal((await svc.applyChef(applicant,{bio:prefix+'重新提交',cuisines:['湘菜'],regionCode:prefix,latitude:28.2,longitude:112.97,healthValidUntil:new Date(now.getTime()+400*86400000).toISOString(),healthAssetId:(await svc.upload(applicant,{mime:'image/png',base64:png})).id,agreement:true,coordinateSystem:'GCJ02'})).status,'PENDING_REVIEW');
  const until=new Date(now.getTime()+400*86400000).toISOString();
  assert.equal((await svc.submitCertificate(users[2],{kind:'HEALTH',assetId:evidence.id,validUntil:until})).status,'PENDING_REVIEW');
  await db.user.update({where:{id:users[2].id},data:{roles:['USER','CHEF','REVIEWER']}});
  const self=await db.user.findUniqueOrThrow({where:{id:users[2].id}});
  try{await assert.rejects(()=>svc.reviewCertificate(self,chefs[0].id,{kind:'HEALTH',action:'approve',reason:'自己审自己'}),/本人/);}
  finally{await db.user.update({where:{id:users[2].id},data:{roles:['USER','CHEF']}});}
  await svc.reviewCertificate(admin,chefs[0].id,{kind:'HEALTH',action:'approve',reason:'新健康证有效'});
  assert.equal((await db.chef.findUniqueOrThrow({where:{id:chefs[0].id}})).healthValidUntil?.toISOString(),until);
  const policy=await svc.upload(users[2],{mime:'image/png',base64:png});
  await svc.submitCertificate(users[2],{kind:'INSURANCE',assetId:policy.id,validUntil:until});
  await svc.reviewCertificate(admin,chefs[0].id,{kind:'INSURANCE',action:'reject',reason:'保单信息不完整'});
  const chef=await db.chef.findUniqueOrThrow({where:{id:chefs[0].id}});
  assert.equal(chef.insuranceValidUntil,null);assert.equal((chef.data as any).pendingCerts.INSURANCE,undefined);
 });
 await t.test('coupons, agreements and a larger published radius follow the current rules',async()=>{
  await assert.rejects(()=>svc.coupons(users[0],true),/尚未开放/);
  const rule=await db.platformRule.findUniqueOrThrow({where:{id:prefix+'rules'}}),data=rule.data as any;
  await db.platformRule.update({where:{id:rule.id},data:{data:{...data,couponEnabled:true,couponFen:500,couponMinFen:1000}}});
  let published:any;
  try{
   const coupon=await svc.coupons(users[0],true);assert.equal((await svc.coupons(users[0],true)).id,coupon.id);assert.equal(coupon.amountFen,500);
   const when=new Date(startsAt.getTime()+5*86400000).toISOString();
   const quote=await svc.quote(users[0],{...input,startsAt:when,couponId:coupon.id});
   assert.equal(quote.details.discountFen,500);assert.equal(quote.totalFen,9300);assert.equal(quote.depositFen,2790);
   await svc.cancelQuote(users[0],quote.id);
   await assert.rejects(()=>svc.publishRules(users[0],{...data,reason:'客户不能改规则'}),/无权/);
   await assert.rejects(()=>svc.publishRules(admin,{...data,radiusM:50,reason:'半径过小'}),/服务半径/);
   published=await svc.publishRules(admin,{...data,radiusM:8000,insuranceRequired:false,reason:'隔离测试临时半径'});
   assert.equal((await svc.chefs({search:prefix,latitude:28.194,longitude:112.961})).find(c=>c.id===chefs[0].id)?.serviceRadiusM,8000);
  }finally{
   if(published)await db.platformRule.delete({where:{id:published.id}});
   await db.platformRule.update({where:{id:rule.id},data:{data}});
  }
  assert.equal((await svc.chefs({search:prefix,latitude:28.194,longitude:112.961})).find(c=>c.id===chefs[0].id)?.serviceRadiusM,15000);
  await assert.rejects(()=>svc.publishAgreement(users[0],{kind:'USER_SERVICE',title:'客户协议',content:'不行'}),'无权');
  const active=await db.agreementVersion.findMany({where:{kind:'USER_SERVICE',active:true}});
  const first=await svc.publishAgreement(admin,{kind:'USER_SERVICE',title:prefix+'协议',content:'第一版测试协议'});
  const second=await svc.publishAgreement(admin,{kind:'USER_SERVICE',title:prefix+'协议',content:'第二版测试协议'});
  try{
   assert.equal(second.version,first.version+1);
   const shown=await svc.agreements('USER_SERVICE');assert.equal(shown.length,1);assert.equal(shown[0].content,'第二版测试协议');assert.equal(Object.hasOwn(shown[0],'publishedBy'),false);
   await assert.rejects(()=>svc.publishAgreement(admin,{kind:'OTHER',title:'无效',content:'无效'}),/协议类型无效/);
  }finally{
   await db.agreementVersion.updateMany({where:{id:{in:[first.id,second.id]}},data:{active:false}});
   if(active.length)await db.agreementVersion.updateMany({where:{id:{in:active.map(v=>v.id)}},data:{active:true}});
  }
 });
 await t.test('an unpaid order cannot be chatted, insured, settled or ticketed twice',async()=>{
  const when=new Date(startsAt.getTime()+4*86400000).toISOString();
  const quote=await svc.quote(users[0],{...input,startsAt:when}),order=await svc.submitQuote(users[0],quote.id);
  try{
   await assert.rejects(()=>svc.messages(users[0],order.id,{body:'你好，到了打电话'}),/接单后/);
   assert.deepEqual(await svc.messages(users[0],order.id),[]);
   await assert.rejects(()=>svc.messages(users[1],order.id),/无权/);
   await assert.rejects(()=>svc.insurance(users[0],order.id,{reason:'测试报案'}),/尚未开通/);
   await assert.rejects(()=>svc.settle(admin,order.id),/尚未开通/);
   await assert.rejects(()=>svc.ticket(users[2],order.id,{reason:'厨师还没接单'}),/仅交易双方|无权/);
   const ticket=await svc.ticket(users[0],order.id,{reason:'还没付款，想先记下问题'});
   assert.equal((await svc.getOrder(users[0],order.id)).aftersaleStatus,'PROCESSING');
   await assert.rejects(()=>svc.ticket(users[0],order.id,{reason:'重复申请'}),/已有处理中/);
   await assert.rejects(()=>svc.opsTickets(users[0]),/无权/);
   assert.equal((await svc.opsTickets(admin)).some(t=>t.id===ticket.id),true);
   await db.serviceTicket.update({where:{id:ticket.id},data:{status:'CLOSED'}});
   await db.order.update({where:{id:order.id},data:{aftersaleStatus:'NONE',feeStatus:'ESTIMATE_CONFIRMED',settlementStatus:'INELIGIBLE'}});
  }finally{await svc.cancel(users[0],order.id,{reason:'测试结束释放档期'});}
  const auth=await svc.login({username:users[0].username,password}),previous=now;now=new Date(now.getTime()+25*3600000);
  try{await assert.rejects(()=>svc.session(auth.token),/过期/);}finally{now=previous;}
  const listed=await svc.opsUsers(admin),row=listed.find(u=>u.id===users[0].id);
  assert.equal(row?.phone,'未绑定');assert.equal(Object.hasOwn(row??{},'phoneEncrypted'),false);
  await assert.rejects(()=>svc.opsUsers(users[0]),/无权/);
  await assert.rejects(()=>svc.revealUserPhone(admin,users[0].id),/未绑定手机号/);
  await assert.rejects(()=>svc.favorites(users[0],'missing-chef'),/厨师不存在/);
 });
 await t.test('addresses, package prices, distant dates and unpaid orders stay inside the service rules',async()=>{
  await assert.rejects(()=>svc.address(users[0],{label:'外地',regionCode:prefix,latitude:30,longitude:112.961,coordinateSystem:'GCJ02',fullText:'不在长沙'}),/长沙服务范围/);
  await assert.rejects(()=>svc.address(users[0],{label:'错误坐标系',regionCode:prefix,latitude:28.194,longitude:112.961,coordinateSystem:'WGS84',fullText:'坐标系不对'}),/GCJ-02/);
  await assert.rejects(()=>svc.deleteAddress(users[1],addr.id),/地址不存在/);
  const saved=await svc.addresses(users[0]);assert.equal(saved.find(a=>a.id===addr.id)?.fullText,'只用于隔离库的测试地址');assert.equal(saved.find(a=>a.id===addr.id)?.encryptedText,undefined);
  assert.equal((await svc.addresses(users[1])).some(a=>a.id===addr.id),false);
  await assert.rejects(()=>svc.savePackage(users[2],{name:'太便宜',description:'低于下限',serviceFen:99}),/服务价格/);
  await assert.rejects(()=>svc.savePackage(users[2],{name:'太贵',description:'高于上限',serviceFen:1000001}),/服务价格/);
  const distant=new Date(now.getTime()+31*86400000);distant.setMinutes(0,0,0);
  await assert.rejects(()=>svc.quote(users[0],{...input,startsAt:distant.toISOString()}),/30天/);
  const when=new Date(startsAt.getTime()+6*86400000).toISOString(),quote=await svc.quote(users[0],{...input,startsAt:when}),order=await svc.submitQuote(users[0],quote.id);
  try{
   await assert.rejects(()=>svc.change(users[0],order.id,{action:'propose',kind:'SCHEDULE',startsAt:when,reason:'想改期'}),/不可改约/);
   await assert.rejects(()=>svc.fulfill(users[2],order.id,{action:'depart',evidence:'出发'}),/无权|只有本单厨师/);
   await assert.rejects(()=>svc.review(users[0],order.id,{taste:5,service:5,punctuality:5,body:'还没做'}),/完成确认后/);
   await assert.rejects(()=>svc.customerAction(users[0],order.id,'confirm',{}),/尚未完成|无权|不存在/);
   const first=await svc.login({username:users[0].username,password}),second=await svc.login({username:users[0].username,password});
   await svc.logout(first.token);await assert.rejects(()=>svc.session(first.token));assert.equal((await svc.session(second.token)).id,users[0].id);await svc.logout(second.token);
  }finally{await svc.cancel(users[0],order.id,{reason:'测试结束释放档期'});}
  await svc.manageChef(admin,chefs[1].id,{action:'BANNED',reason:'隔离测试封禁'});
  try{assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===chefs[1].id),false);}
  finally{await svc.manageChef(admin,chefs[1].id,{action:'RESTORE',reason:'隔离测试解除封禁'});}
  assert.equal((await svc.chefs({search:prefix})).some(c=>c.id===chefs[1].id),true);
  await assert.rejects(()=>svc.opsChefs(users[0]),/无权/);
  const dossier=await svc.opsChefs(admin),mine=dossier.find(c=>c.id===chefs[0].id);
  assert.equal(mine?.data.payoutAccount,undefined);assert.equal(mine?.data.payoutName,undefined);assert.ok(mine?.data.healthAssetId);
 });
 await t.test('submit pending payment exactly once; no fabricated financial records or insurance',async()=>{
  const quote=await svc.quote(users[0],input),[a,b]=await Promise.all([svc.submitQuote(users[0],quote.id),svc.submitQuote(users[0],quote.id)]);
  assert.equal(a.id,b.id);assert.equal(a.contractStatus,'PENDING_PAYMENT');assert.equal(a.paymentStatus,'UNPAID');assert.equal(a.receivedFen,0);assert.equal(a.sandbox,false);
  assert.equal(await db.paymentRequest.count({where:{orderId:a.id}}),0);assert.equal(await db.ledgerEntry.count({where:{orderId:a.id}}),0);assert.equal(await db.insurancePolicy.count({where:{orderId:a.id}}),0);
  await assert.rejects(()=>svc.payQuote(users[0],quote.id,{paymentChoice:'DEPOSIT',idempotencyKey:randomUUID()}),/在线支付尚未开通/);
  await assert.rejects(()=>svc.getOrder(users[1],a.id));await assert.rejects(()=>svc.cancelQuote(users[0],quote.id));
  const cancelled=await svc.cancel(users[0],a.id,{reason:'测试取消未支付订单'});assert.equal(cancelled.contractStatus,'CANCELLED');assert.equal(cancelled.paymentStatus,'UNPAID');assert.equal(cancelled.refundedFen,0);
  await assert.rejects(()=>svc.deleteAddress(users[0],addr.id),/不可删除/);
  const spare=await svc.address(users[0],{label:'可删除',regionCode:prefix,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'没有订单的地址'});
  assert.equal((await svc.deleteAddress(users[0],spare.id)).ok,true);
 });
 await t.test('unpaid order expires and releases slot without fake refund',async()=>{
  const quote=await svc.quote(users[0],input),order=await svc.submitQuote(users[0],quote.id);
  now=new Date(now.getTime()+31*60000);await svc.tick();assert.equal((await svc.getOrder(users[0],order.id)).contractStatus,'CANCELLED');assert.equal(await db.bookingLock.count({where:{quoteId:quote.id}}),0);
 });
 await writeFile('.data/business-fixture.json',JSON.stringify({prefix,password,chefs:chefs.map(c=>c.id),packages:packages.map(p=>p.id),regionCode:prefix,startsAt:startsAt.toISOString()}));
});
