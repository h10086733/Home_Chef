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
  for(const suffix of ['customer','stranger','chef0','chef1']){const a=await svc.login({username:prefix+suffix,password,displayName:prefix+suffix},true);users.push(await svc.session(a.token));}
  await assert.rejects(()=>svc.login({username:users[0].username,password,displayName:'重复'},true),/账号已存在/);
  await assert.rejects(()=>svc.login({username:users[0].username,password:'wrong'}),/账号或密码不正确/);
  const auth=await svc.login({username:users[0].username,password});assert.equal((await svc.session(auth.token)).id,users[0].id);await svc.logout(auth.token);await assert.rejects(()=>svc.session(auth.token));
  assert.deepEqual(await svc.orders(users[1]),[]);assert.deepEqual(await svc.addresses(users[1]),[]);
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
   assert.equal((await svc.chefs({search:prefix,latitude:28.24,longitude:112.961})).length,0);
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
 await t.test('submit pending payment exactly once; no fabricated financial records or insurance',async()=>{
  const quote=await svc.quote(users[0],input),[a,b]=await Promise.all([svc.submitQuote(users[0],quote.id),svc.submitQuote(users[0],quote.id)]);
  assert.equal(a.id,b.id);assert.equal(a.contractStatus,'PENDING_PAYMENT');assert.equal(a.paymentStatus,'UNPAID');assert.equal(a.receivedFen,0);assert.equal(a.sandbox,false);
  assert.equal(await db.paymentRequest.count({where:{orderId:a.id}}),0);assert.equal(await db.ledgerEntry.count({where:{orderId:a.id}}),0);assert.equal(await db.insurancePolicy.count({where:{orderId:a.id}}),0);
  await assert.rejects(()=>svc.payQuote(users[0],quote.id,{paymentChoice:'DEPOSIT',idempotencyKey:randomUUID()}),/在线支付尚未开通/);
  await assert.rejects(()=>svc.getOrder(users[1],a.id));await assert.rejects(()=>svc.cancelQuote(users[0],quote.id));
  const cancelled=await svc.cancel(users[0],a.id,{reason:'测试取消未支付订单'});assert.equal(cancelled.contractStatus,'CANCELLED');assert.equal(cancelled.paymentStatus,'UNPAID');assert.equal(cancelled.refundedFen,0);
 });
 await t.test('unpaid order expires and releases slot without fake refund',async()=>{
  const quote=await svc.quote(users[0],input),order=await svc.submitQuote(users[0],quote.id);
  now=new Date(now.getTime()+31*60000);await svc.tick();assert.equal((await svc.getOrder(users[0],order.id)).contractStatus,'CANCELLED');assert.equal(await db.bookingLock.count({where:{quoteId:quote.id}}),0);
 });
 await writeFile('.data/business-fixture.json',JSON.stringify({prefix,password,chefs:chefs.map(c=>c.id),packages:packages.map(p=>p.id),regionCode:prefix,startsAt:startsAt.toISOString()}));
});
