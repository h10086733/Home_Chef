import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {MvpService} from '../apps/api/src/support';
import {ChefFinanceService} from '../apps/api/src/chef-finance';
import {hashPassword,checkPassword,encrypt,decrypt} from '../apps/api/src/security';
const db=new PrismaClient();
let now=new Date();now.setUTCSeconds(0,0);
const service=new MvpService(db,()=>now),prefix='t'+randomUUID().replaceAll('-','').slice(0,12);
const users:Record<string,any>={},chefIds:string[]=[];
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const start=(days:number)=>{const d=new Date(now.getTime()+days*86400000);d.setUTCHours(10,0,0,0);return d;};
let addressId:string,ruleId:string;
after(async()=>{await db.$disconnect();});
async function fixture(){
 for(const[name,roles]of Object.entries({customer:['USER'],stranger:['USER'],chef0:['USER','CHEF'],chef1:['USER','CHEF'],chef2:['USER','CHEF'],operator:['ADMIN','REVIEWER'],support:['CUSTOMER_SERVICE'],manager:['FINANCE_MANAGER'],finance:['FINANCE']})){
  users[name]=await db.user.create({data:{username:prefix+'_'+name,displayName:name,roles:roles as any,passwordHash:hashPassword('TestingPassword2026!')}});
 }
 ruleId=prefix+'-rules';
 await db.platformRule.create({data:{id:ruleId,publishedBy:users.operator.id,data:{sandbox:true,regions:[{code:prefix,name:'测试片区',active:true}],radiusM:3000,matchMinutes:10,urgentMinMinutes:30,autoConfirmHours:48,settlementTrigger:'REVIEW_OR_EXPIRE',settlementDelayHours:0,commissionRate:.15,couponEnabled:true,couponFen:2000,couponMinFen:20000}}});
 const a=await service.address(users.customer,{label:'家',regionCode:prefix,latitude:28.194,longitude:112.961,fullText:'仅属于测试用户的完整地址'});addressId=a.id;
 for(let i=0;i<3;i++){
  const c=await db.chef.create({data:{userId:users['chef'+i].id,status:'TRIAL',acceptingOrders:true,healthValidUntil:new Date(now.getTime()+180*86400000),data:{regionCode:prefix,latitude:28.194+i*.001,longitude:112.961,cuisines:['湘菜']}}});chefIds.push(c.id);
  await db.servicePackage.create({data:{id:prefix+'-pkg'+i,chefId:c.id,name:'测试家宴',description:'做饭和基础归位',serviceFen:30000}});
  await db.scheduleSlot.create({data:{chefId:c.id,startsAt:new Date(now.getTime()-86400000),endsAt:new Date(now.getTime()+60*86400000)}});
 }
}
const input=(day:number,extra:Record<string,any>={})=>({packageId:prefix+'-pkg0',addressId,startsAt:start(day).toISOString(),hours:2,guests:4,allergens:'无已知过敏',kitchen:'燃气灶具可用',cuisine:'湘菜',ingredientMode:'CUSTOMER',mode:'SELF',...extra});
const pay=(q:any,extra:Record<string,any>={})=>service.payQuote(users.customer,q.id,{paymentChoice:'DEPOSIT',idempotencyKey:randomUUID(),...extra});
test('MVP PostgreSQL acceptance scenarios',async t=>{
 await fixture();
 await t.test('password hashes and address encryption round-trip',async()=>{
  const p=hashPassword('abc123');assert(checkPassword('abc123',p));assert(!checkPassword('wrong',p));
  const cipher=encrypt('长沙地址');assert(!cipher.includes('长沙'));assert.equal(decrypt(cipher),'长沙地址');
  const stored=await db.address.findUniqueOrThrow({where:{id:addressId}});assert(!stored.encryptedText!.includes('完整地址'));
  const auth=await service.login({username:users.customer.username,password:'TestingPassword2026!'});
  assert.equal((await service.session(auth.token)).id,users.customer.id);
  await service.logout(auth.token);await assert.rejects(()=>service.session(auth.token));
 });
 await t.test('server pricing, required allergies and address ownership',async()=>{
  await assert.rejects(()=>service.quote(users.customer,input(2,{allergens:''})));
  await assert.rejects(()=>service.quote(users.stranger,input(2)));
  await assert.rejects(()=>service.quote(users.customer,input(2,{startsAt:new Date(now.getTime()+3600000).toISOString()})));
  const q=await service.quote(users.customer,input(2,{totalFen:1}));
  assert.equal(q.totalFen,30000);assert.equal(q.depositFen,9000);
  await assert.rejects(()=>service.quote(users.customer,input(2)),/档期/);
  const o=await pay(q,{idempotencyKey:'first'}),same=await pay(q,{idempotencyKey:'first'});
  assert.equal(o.id,same.id);assert.equal(await db.paymentRequest.count({where:{orderId:o.id}}),1);
  await assert.rejects(()=>service.payQuote(users.customer,q.id,{paymentChoice:'FULL_PAYMENT',idempotencyKey:'first'}),/幂等键/);
  await assert.rejects(()=>service.getOrder(users.stranger,o.id),/无权/);
  const candidate=await service.getOrder(users.chef0,o.id);
  assert.equal(candidate.details.fullAddress,undefined);assert.equal(candidate.details.encryptedAddress,undefined);
  await service.accept(users.chef0,o.id);
  assert.equal((await service.getOrder(users.chef0,o.id)).details.fullAddress,undefined);
  await service.customerAction(users.customer,o.id,'address-consent',{});
  assert.equal((await service.getOrder(users.chef0,o.id)).details.fullAddress,'仅属于测试用户的完整地址');
  await service.cancel(users.customer,o.id,{reason:'提前24h以上取消定金单'});
  const cancelled=await db.order.findUniqueOrThrow({where:{id:o.id}});
  assert.equal(cancelled.receivedFen,9000);assert.equal(cancelled.refundedFen,9000);assert.equal(cancelled.balanceFen,0);
  assert.equal(await db.bookingLock.count({where:{orderId:o.id}}),0);
  await assert.rejects(()=>service.accept(users.chef0,o.id));
  assert.equal((await service.getOrder(users.chef0,o.id)).details.fullAddress,undefined);
 });
 await t.test('concurrent payment retries and candidate claim have one winner',async()=>{
  const q=await service.quote(users.customer,input(3,{mode:'MATCH'}));
  const results=await Promise.all([pay(q,{idempotencyKey:'parallel'}),pay(q,{idempotencyKey:'parallel'})]);
  assert.equal(results[0].id,results[1].id);const o=results[0];
  assert.equal(o.acceptedChefId,null);assert.equal(await db.bookingLock.count({where:{orderId:o.id}}),0);
  const claims=await Promise.allSettled([service.accept(users.chef0,o.id),service.accept(users.chef1,o.id)]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await db.bookingLock.count({where:{orderId:o.id}}),1);
  const winner=await db.order.findUniqueOrThrow({where:{id:o.id}});
  const account=winner.acceptedChefId===chefIds[0]?users.chef0:users.chef1;
  await service.cancel(account,o.id,{reason:'测试厨师取消'});
 });
 await t.test('one chef cannot claim two overlapping matching orders',async()=>{
  const q1=await service.quote(users.customer,input(4,{mode:'MATCH'})),q2=await service.quote(users.customer,input(4,{mode:'MATCH'}));
  const a=await pay(q1),b=await pay(q2);
  const claims=await Promise.allSettled([service.accept(users.chef0,a.id),service.accept(users.chef0,b.id)]);
  assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
  for(const o of[a,b]){const current=await db.order.findUniqueOrThrow({where:{id:o.id}});await service.cancel(current.acceptedChefId?users.chef0:users.customer,o.id,{reason:'测试清理'});}
 });
 await t.test('payment/cancel races cannot create duplicate refund or revive an order',async()=>{
  const q=await service.quote(users.customer,input(5));const o=await pay(q);
  await Promise.all([service.cancel(users.customer,o.id,{reason:'取消'}),service.cancel(users.customer,o.id,{reason:'重试'})]);
  assert.equal(await db.ledgerEntry.count({where:{orderId:o.id,kind:'REFUND'}}),1);
  assert.equal((await db.ledgerEntry.aggregate({where:{orderId:o.id},_sum:{amountFen:true}}))._sum.amountFen,0);
 });
 await t.test('late accept rejected and durable timeout refunds only paid deposit',async()=>{
  const q=await service.quote(users.customer,input(6));const o=await pay(q),previous=now;
  now=new Date(now.getTime()+5*60000);
  await assert.rejects(()=>service.accept(users.chef0,o.id),/期限/);
  await service.tick();const row=await db.order.findUniqueOrThrow({where:{id:o.id}});
  assert.equal(row.contractStatus,'CANCELLED');assert.equal(row.refundedFen,row.depositFen);now=previous;
 });
 await t.test('coupon locked at payment, refunded on cancellation, with rules snapshot',async()=>{
  const coupon=await service.coupons(users.customer,true) as any;
  const q=await service.quote(users.customer,input(7,{couponId:coupon.id}));
  assert.equal(q.totalFen,28000);assert.equal(q.depositFen,8400);
  const o=await pay(q);
  assert.equal((await db.coupon.findUniqueOrThrow({where:{id:coupon.id}})).status,'USED');
  await service.publishRules(users.operator,{...q.details.rules,commissionRate:.2,commissionBase:'SERVICE',insuranceRequired:false,reason:'测试规则版本'});
  assert.equal((o.ruleSnapshot as any).commissionRate,.15);
  await service.cancel(users.customer,o.id,{reason:'取消退券'});
  assert.equal((await db.coupon.findUniqueOrThrow({where:{id:coupon.id}})).status,'AVAILABLE');
 });
 await t.test('fulfillment, receipt validation, fee reduction, unpaid confirmation and settlement',async()=>{
  const q=await service.quote(users.customer,input(8,{ingredientMode:'CHEF',ingredientFen:20000})),o=await pay(q);
  await service.accept(users.chef0,o.id);
  await assert.rejects(()=>service.fulfill(users.chef0,o.id,{action:'start',evidence:'跳过到达'}));
  const previous=now;now=new Date(q.details.startsAt);
  for(const action of['depart','arrive','start'])await service.fulfill(users.chef0,o.id,{action,evidence:'测试签到'});
  await assert.rejects(()=>service.fulfill(users.chef0,o.id,{action:'complete',evidence:'完成',actualIngredientFen:10000}));
  const asset=await service.upload(users.chef0,{orderId:o.id,mime:'image/png',base64:png});
  await service.fulfill(users.chef0,o.id,{action:'complete',evidence:'菜品已交接',assetId:asset.id,receiptId:asset.id,actualIngredientFen:10000});
  await service.customerAction(users.customer,o.id,'confirm-fees',{});
  let row=await db.order.findUniqueOrThrow({where:{id:o.id}});assert.equal(row.balanceFen,25000);
  await service.customerAction(users.customer,o.id,'confirm',{});
  row=await db.order.findUniqueOrThrow({where:{id:o.id}});assert.equal(row.fulfillmentStatus,'COMPLETED');assert.equal(row.settlementStatus,'FROZEN');assert.equal(row.reviewStatus,'OPEN');
  await assert.rejects(()=>service.settle(users.finance,o.id),/结算/);
  await service.customerAction(users.customer,o.id,'balance',{idempotencyKey:'balance'});
  await service.customerAction(users.customer,o.id,'balance',{idempotencyKey:'balance'});
  assert.equal(await db.paymentRequest.count({where:{orderId:o.id,kind:'BALANCE'}}),1);
  await assert.rejects(()=>service.settle(users.finance,o.id),/评价/);
  await service.review(users.customer,o.id,{taste:5,service:4,punctuality:5,body:'家宴满意'});
  const settled=await service.settle(users.finance,o.id);assert.equal((settled as any).chefFen,34000);
  await service.settle(users.finance,o.id);assert.equal(await db.ledgerEntry.count({where:{reference:'settlement:'+o.id}}),1);
  await assert.rejects(()=>service.review(users.customer,o.id,{taste:5,service:5,punctuality:5,body:'重复'}));
  await service.review(users.customer,o.id,{followup:'下次还会预约'});
  now=previous;
 });
 await t.test('IM sensitive message is blocked yet recorded and not shown to chef',async()=>{
  const q=await service.quote(users.customer,input(9)),o=await pay(q);await service.accept(users.chef0,o.id);
  await assert.rejects(()=>service.messages(users.customer,o.id,{body:'加我微信 wx abc123'}),/拦截/);
  assert.equal(await db.chatMessage.count({where:{orderId:o.id,blocked:true}}),1);
  assert.equal((await service.messages(users.chef0,o.id) as any[]).length,0);
  await service.messages(users.customer,o.id,{body:'少放辣椒，谢谢'});
  assert.equal((await service.messages(users.chef0,o.id) as any[]).length,1);
  await service.cancel(users.chef0,o.id,{reason:'测试结束'});
 });
 await t.test('support proposal, independent approval, financial execution and audit immutability',async()=>{
  const q=await service.quote(users.customer,input(10)),o=await pay(q);await service.accept(users.chef0,o.id);
  const ticket=await service.ticket(users.customer,o.id,{reason:'厨师无法履约'});
  await assert.rejects(()=>service.decideTicket(users.customer,ticket.id,{action:'propose',refundFen:o.receivedFen,decision:'自批退款'}));
  await service.decideTicket(users.support,ticket.id,{action:'propose',refundFen:o.receivedFen,decision:'确认厨师无法履约，退实收'});
  await assert.rejects(()=>service.decideTicket(users.finance,ticket.id,{action:'execute'}));
  await service.decideTicket(users.manager,ticket.id,{action:'approve'});
  await service.decideTicket(users.finance,ticket.id,{action:'execute'});
  const row=await db.order.findUniqueOrThrow({where:{id:o.id}});assert.equal(row.aftersaleStatus,'CLOSED');assert.equal(row.refundedFen,row.receivedFen);
  const event=await db.auditEvent.findFirstOrThrow({where:{aggregateId:o.id}});
  await assert.rejects(()=>db.auditEvent.delete({where:{id:event.id}}),/append-only/);
  const ledger=await db.ledgerEntry.findFirstOrThrow({where:{orderId:o.id}});
  await assert.rejects(()=>db.ledgerEntry.update({where:{id:ledger.id},data:{amountFen:0}}),/append-only/);
 });
 await t.test('adjudicated remainder settles, and a settled refund posts recovery without rewriting the settlement',async()=>{
  const previous=now;
  async function served(day:number){
   const q=await service.quote(users.customer,input(day)),o=await pay(q,{paymentChoice:'FULL_PAYMENT'});
   await service.accept(users.chef0,o.id);now=new Date(q.details.startsAt);
   for(const action of ['depart','arrive','start'])await service.fulfill(users.chef0,o.id,{action,evidence:'测试签到'});
   const asset=await service.upload(users.chef0,{orderId:o.id,mime:'image/png',base64:png});
   await service.fulfill(users.chef0,o.id,{action:'complete',evidence:'完成',assetId:asset.id,actualIngredientFen:0});
   await service.customerAction(users.customer,o.id,'confirm-fees',{});
   await service.customerAction(users.customer,o.id,'confirm',{});
   return db.order.findUniqueOrThrow({where:{id:o.id}});
  }
  try{
   const open=await served(18);
   const ticket=await service.ticket(users.customer,open.id,{reason:'少做一道'});
   await service.decideTicket(users.support,ticket.id,{action:'propose',refundFen:6000,decision:'退部分服务费'});
   await service.decideTicket(users.manager,ticket.id,{action:'approve'});
   await service.decideTicket(users.finance,ticket.id,{action:'execute'});
   let row=await db.order.findUniqueOrThrow({where:{id:open.id}});
   assert.equal(row.refundedFen,6000);assert.equal(row.settlementStatus,'PENDING');assert.equal((row.details as any).adjudicatedNetFen,24000);
   const rate=(open.ruleSnapshot as any).commissionRate as number,fullChef=30000-Math.round(30000*rate),nextChef=24000-Math.round(24000*rate);
   await service.review(users.customer,open.id,{taste:4,service:4,punctuality:4,body:'已裁定'});
   now=open.confirmedAt!;
   const partial=await service.settle(users.finance,open.id);assert.equal((partial as any).chefFen,nextChef);assert.equal((partial as any).commissionFen,Math.round(24000*rate));
   const done=await served(19);
   await service.review(users.customer,done.id,{taste:5,service:5,punctuality:5,body:'先结算'});
   now=done.confirmedAt!;
   const settled=await service.settle(users.finance,done.id);assert.equal((settled as any).chefFen,fullChef);
   const again=await service.ticket(users.customer,done.id,{reason:'结算后退一部分'});
   await service.decideTicket(users.support,again.id,{action:'propose',refundFen:6000,decision:'结算后退服务费'});
   await service.decideTicket(users.manager,again.id,{action:'approve'});
   await service.decideTicket(users.finance,again.id,{action:'execute'});
   row=await db.order.findUniqueOrThrow({where:{id:done.id}});
   assert.equal(row.settlementStatus,'SETTLED');assert.equal(row.refundedFen,6000);
   assert.equal((await db.ledgerEntry.findUniqueOrThrow({where:{reference:'recovery:'+again.id}})).amountFen,fullChef-nextChef);
   assert.equal((await db.ledgerEntry.findUniqueOrThrow({where:{reference:'settlement:'+done.id}})).amountFen,-fullChef);
  }finally{now=previous;}
 });
 await t.test('48h confirmation does not auto-charge balance; outbox deliveries deduplicate',async()=>{
  const q=await service.quote(users.customer,input(11)),o=await pay(q);await service.accept(users.chef0,o.id);
  const previous=now;now=new Date(q.details.startsAt);
  for(const action of['depart','arrive','start'])await service.fulfill(users.chef0,o.id,{action,evidence:'记录'});
  const a=await service.upload(users.chef0,{orderId:o.id,mime:'image/png',base64:png});
  await service.fulfill(users.chef0,o.id,{action:'complete',evidence:'完成',assetId:a.id,actualIngredientFen:0});
  now=new Date(now.getTime()+47*3600000);await service.tick();assert.equal((await db.order.findUniqueOrThrow({where:{id:o.id}})).fulfillmentStatus,'AWAITING_CONFIRMATION');
  now=new Date(now.getTime()+3600000);await service.tick();const row=await db.order.findUniqueOrThrow({where:{id:o.id}});
  assert.equal(row.fulfillmentStatus,'COMPLETED');assert.equal(row.balanceFen,21000);assert.equal(row.receivedFen,9000);assert.equal(row.settlementStatus,'FROZEN');
  const count=await db.notification.count({where:{orderId:o.id}});await service.tick();assert.equal(await db.notification.count({where:{orderId:o.id}}),count);now=previous;
 });

 await t.test('reschedule requires counterparty and retains old slot until confirmation',async()=>{
  const q=await service.quote(users.customer,input(12)),o=await pay(q);await service.accept(users.chef0,o.id);
  const newStart=start(13).toISOString();
  const proposed=await service.change(users.customer,o.id,{action:'propose',kind:'SCHEDULE',startsAt:newStart,reason:'用户调整日期'});
  assert.equal(proposed.details.startsAt,q.details.startsAt);
  await assert.rejects(()=>service.change(users.customer,o.id,{action:'accept',changeId:proposed.details.pendingChange.id}),/另一方/);
  const changed=await service.change(users.chef0,o.id,{action:'accept',changeId:proposed.details.pendingChange.id});
  assert.equal(changed.details.startsAt,newStart);
  const lock=await db.bookingLock.findUniqueOrThrow({where:{orderId:o.id}});
  assert.equal(lock.startsAt.getTime(),new Date(newStart).getTime()-3600000);
  await service.cancel(users.chef0,o.id,{reason:'测试结束'});
 });
 await t.test('procurement overrun needs customer approval and records only the increment',async()=>{
  const q=await service.quote(users.customer,input(14,{ingredientMode:'CHEF',ingredientFen:10000})),o=await pay(q);await service.accept(users.chef0,o.id);
  const proposed=await service.change(users.chef0,o.id,{action:'propose',kind:'BUDGET',ingredientFen:15000,reason:'增加已商议食材'});
  assert.equal(proposed.receivedFen,12000);
  const changed=await service.change(users.customer,o.id,{action:'accept',changeId:proposed.details.pendingChange.id});
  assert.equal(changed.receivedFen,17000);assert.equal(changed.totalFen,45000);assert.equal(changed.balanceFen,28000);
  assert.equal((await db.paymentRequest.findFirstOrThrow({where:{orderId:o.id,kind:'ADDITIONAL'}})).amountFen,5000);
  await assert.rejects(()=>service.change(users.customer,o.id,{action:'accept',changeId:proposed.details.pendingChange.id}));
  await service.cancel(users.chef0,o.id,{reason:'测试结束'});
 });

 await t.test('withdrawn quote releases soft lock and cannot be paid',async()=>{
  const q=await service.quote(users.customer,input(15));
  await assert.rejects(()=>service.cancelQuote(users.stranger,q.id));
  await service.cancelQuote(users.customer,q.id);
  assert.equal(await db.bookingLock.count({where:{quoteId:q.id}}),0);
  await assert.rejects(()=>pay(q));
  const next=await service.quote(users.customer,input(15));assert(next.id!==q.id);
  await service.cancelQuote(users.customer,next.id);
 });
 await t.test('full payment refunds procurement difference once without reducing cumulative receipts',async()=>{
  const q=await service.quote(users.customer,input(16,{ingredientMode:'CHEF',ingredientFen:10000})),o=await pay(q,{paymentChoice:'FULL_PAYMENT'});
  await service.accept(users.chef0,o.id);const previous=now;now=new Date(q.details.startsAt);
  for(const action of['depart','arrive','start'])await service.fulfill(users.chef0,o.id,{action,evidence:'履约'});
  const a=await service.upload(users.chef0,{orderId:o.id,mime:'image/png',base64:png});
  await service.fulfill(users.chef0,o.id,{action:'complete',evidence:'完成',assetId:a.id,receiptId:a.id,actualIngredientFen:5000});
  await service.customerAction(users.customer,o.id,'confirm-fees',{});await service.customerAction(users.customer,o.id,'confirm-fees',{});
  const row=await db.order.findUniqueOrThrow({where:{id:o.id}});assert.equal(row.receivedFen,40000);assert.equal(row.refundedFen,5000);assert.equal(row.balanceFen,0);
  assert.equal(await db.ledgerEntry.count({where:{orderId:o.id,kind:'REFUND'}}),1);
  await service.customerAction(users.customer,o.id,'confirm',{});now=previous;
 });
 await t.test('operations can freeze users, manage chef access and publish versioned agreements',async()=>{
  const auth=await service.login({username:users.stranger.username,password:'TestingPassword2026!'});
  await service.manageUser(users.operator,users.stranger.id,{action:'freeze',reason:'隔离测试冻结'});await assert.rejects(()=>service.session(auth.token),/过期|冻结/);
  await service.manageUser(users.operator,users.stranger.id,{action:'restore',reason:'隔离测试恢复'});assert.equal((await db.user.findUniqueOrThrow({where:{id:users.stranger.id}})).status,'ACTIVE');
  await service.manageChef(users.operator,chefIds[2],{action:'SUSPENDED',reason:'隔离测试限制'});assert.equal((await db.chef.findUniqueOrThrow({where:{id:chefIds[2]}})).acceptingOrders,false);
  await service.manageChef(users.operator,chefIds[2],{action:'RESTORE',reason:'隔离测试恢复'});assert.equal((await db.chef.findUniqueOrThrow({where:{id:chefIds[2]}})).acceptingOrders,true);
  const first=await service.publishAgreement(users.operator,{kind:'USER_SERVICE',title:'测试用户协议',content:'第一版内容'}),second=await service.publishAgreement(users.operator,{kind:'USER_SERVICE',title:'测试用户协议',content:'第二版内容'});
  assert.equal(second.version,first.version+1);const agreements=await service.agreements('USER_SERVICE');assert.equal(agreements.length,1);assert.equal(agreements[0].version,second.version);
  assert((await service.opsUsers(users.operator)).some(u=>u.id===users.stranger.id));assert.equal(await db.auditEvent.count({where:{aggregateId:users.stranger.id,action:{startsWith:'USER_'}}}),2);
 });
 await t.test('SRS V1.0 rules: insurance gate, booking window, cancellation tiers, compensation settlement, IM masking',async()=>{
  const live=await service.rules(db);
  await service.publishRules(users.operator,{...live,srsVersion:undefined,settlementTrigger:undefined,commissionBase:undefined,insuranceRequired:undefined,commissionRate:0,reason:'切换到需求说明书 V1.0 规则'});
  const rules=await service.rules(db);assert.equal(rules.srsVersion,'1.0');assert.equal(rules.settlementTrigger,'CONFIRM_DELAY');assert.equal(rules.insuranceRequired,true);
  const at=(h:number)=>{const d=new Date(now.getTime()+h*3600000);d.setUTCMinutes(0,0,0);return d.toISOString();};
  await assert.rejects(()=>service.quote(users.customer,input(2)),/不可预约/);
  const policy=await service.upload(users.chef0,{mime:'image/png',base64:png});
  await service.submitCertificate(users.chef0,{kind:'INSURANCE',assetId:policy.id,validUntil:new Date(now.getTime()+365*86400000).toISOString()});
  await assert.rejects(()=>service.reviewCertificate(users.chef0,chefIds[0],{kind:'INSURANCE',action:'approve',reason:'自审'}));
  await service.reviewCertificate(users.operator,chefIds[0],{kind:'INSURANCE',action:'approve',reason:'保单有效'});
  assert((await db.chef.findUniqueOrThrow({where:{id:chefIds[0]}})).insuranceValidUntil);
  assert((await service.chefs()).some(c=>c.id===chefIds[0]));assert(!(await service.chefs()).some(c=>c.id===chefIds[1]));
  await assert.rejects(()=>service.quote(users.customer,input(0,{startsAt:new Date(Math.ceil((now.getTime()+3600000)/1800000)*1800000).toISOString()})),/预约时间/);

  const free=await pay(await service.quote(users.customer,input(2)));
  assert.equal(new Date(free.details.acceptanceDeadline).getTime()-now.getTime(),30*60000);
  await service.accept(users.chef0,free.id);
  assert.equal((await service.cancelPreview(users.customer,free.id)).tier,'FREE');
  await service.cancel(users.customer,free.id,{reason:'提前两天取消'});
  let row=await db.order.findUniqueOrThrow({where:{id:free.id}});assert.equal(row.refundedFen,row.receivedFen);assert.equal(row.settlementStatus,'INELIGIBLE');

  const mid=await pay(await service.quote(users.customer,input(0,{startsAt:at(12)})),{paymentChoice:'FULL_PAYMENT'});
  await service.accept(users.chef0,mid.id);
  await service.messages(users.customer,mid.id,{body:'我们私下转账吧'});
  assert.equal((await db.chatMessage.findFirstOrThrow({where:{orderId:mid.id}})).body,'我们******吧');
  const preview=await service.cancelPreview(users.customer,mid.id);assert.deepEqual([preview.tier,preview.deductFen,preview.refundFen],['MID',9000,21000]);
  await assert.rejects(()=>service.cancel(users.customer,mid.id,{reason:'临时有事',expectedDeductFen:0}),/重新确认/);
  await service.cancel(users.customer,mid.id,{reason:'临时有事',expectedDeductFen:9000});
  row=await db.order.findUniqueOrThrow({where:{id:mid.id}});assert.equal(row.refundedFen,21000);assert.equal(row.settlementStatus,'PENDING');assert.equal((row.details as any).cancelCompensationFen,9000);
  const finance=new ChefFinanceService(db,()=>now);
  await finance.autoSettle();
  assert.equal((await db.order.findUniqueOrThrow({where:{id:mid.id}})).settlementStatus,'PENDING');
  const previous=now;now=new Date(now.getTime()+25*3600000);
  await finance.autoSettle();now=previous;
  row=await db.order.findUniqueOrThrow({where:{id:mid.id}});assert.equal(row.settlementStatus,'SETTLED');assert.equal((row.details as any).settlement.chefFen,9000);
  assert.equal((await db.ledgerEntry.aggregate({where:{orderId:mid.id},_sum:{amountFen:true}}))._sum.amountFen,0);

  const late=await pay(await service.quote(users.customer,input(0,{startsAt:at(3)})),{paymentChoice:'FULL_PAYMENT'});
  await service.accept(users.chef0,late.id);
  const before=now;now=new Date(new Date(late.details.startsAt).getTime()-20*60000);
  for(const action of['depart','arrive'])await service.fulfill(users.chef0,late.id,{action,evidence:'已到达'});
  assert.deepEqual((({tier,deductFen})=>[tier,deductFen])(await service.cancelPreview(users.customer,late.id)),['ARRIVED',30000]);
  await service.cancel(users.customer,late.id,{reason:'到达后取消'});now=before;
  row=await db.order.findUniqueOrThrow({where:{id:late.id}});assert.equal(row.refundedFen,0);assert.equal((row.details as any).cancelCompensationFen,30000);

  const chefCancel=await pay(await service.quote(users.customer,input(3)));await service.accept(users.chef0,chefCancel.id);
  await assert.rejects(()=>service.cancel(users.chef0,chefCancel.id,{}),/取消原因/);
  await service.cancel(users.chef0,chefCancel.id,{reason:'家中急事'});
  row=await db.order.findUniqueOrThrow({where:{id:chefCancel.id}});assert.equal(row.refundedFen,row.receivedFen);
  assert.equal(await db.chefPenalty.count({where:{chefId:chefIds[0],kind:'VIOLATION',reason:'接单后取消：家中急事'}}),1);
 });
 await t.test('SRS V1.0 accounts: agreement, password lockout and delayed deletion',async()=>{
  await assert.rejects(()=>service.login({username:prefix+'_new',password:'TestingPassword2026!',displayName:'新用户'},true),/协议/);
  const created=await service.login({username:prefix+'_new',password:'TestingPassword2026!',displayName:'新用户',agreed:true},true);
  assert((await db.user.findUniqueOrThrow({where:{id:created.user.id}})).agreedAt);
  for(let i=0;i<5;i++)await assert.rejects(()=>service.login({username:prefix+'_new',password:'wrong-password'}),/不正确/);
  await assert.rejects(()=>service.login({username:prefix+'_new',password:'TestingPassword2026!'}),/30 分钟/);
  const previous=now;now=new Date(now.getTime()+31*60000);
  const back=await service.login({username:prefix+'_new',password:'TestingPassword2026!'});
  const me=await service.session(back.token);
  await assert.rejects(()=>service.requestDeletion(me,{}),/确认/);
  const requested=await service.requestDeletion(me,{confirm:true});assert.equal(new Date(requested.effectiveAt).getTime()-now.getTime(),15*86400000);
  await assert.rejects(()=>service.session(back.token));
  await service.login({username:prefix+'_new',password:'TestingPassword2026!'});
  assert.equal((await db.user.findUniqueOrThrow({where:{id:me.id}})).deletionRequestedAt,null);
  await service.requestDeletion(me,{confirm:true});
  now=new Date(now.getTime()+16*86400000);await service.tick();now=previous;
  const gone=await db.user.findUniqueOrThrow({where:{id:me.id}});assert.equal(gone.status,'DELETED');assert.equal(gone.username,null);assert.equal(gone.passwordHash,null);
  await assert.rejects(()=>service.requestDeletion(users.operator,{confirm:true}),/工作人员/);
 });
 await t.test('a chef found by location can be quoted when the address district code differs',async()=>{
  const live=await service.rules(db),other=prefix+'-other';
  await service.publishRules(users.operator,{...live,regions:[...live.regions,{code:other,name:'另一开放片区',active:true}],reason:'上门范围按距离，不要求片区代码相同'});
  const near=await service.address(users.customer,{label:'定位点',regionCode:other,latitude:28.194,longitude:112.961,fullText:'与厨师出发位置相同、片区代码不同的测试地址'});
  assert((await service.chefs({latitude:28.194,longitude:112.961})).some(c=>c.id===chefIds[0]));
  assert(!(await service.chefs({latitude:28.194,longitude:112.961,regionCode:other})).some(c=>c.id===chefIds[0]));
  const q=await service.quote(users.customer,input(21,{addressId:near.id}));
  assert.equal(q.chefId,chefIds[0]);
  const far=await service.address(users.customer,{label:'远处',regionCode:other,latitude:28.25,longitude:113.05,fullText:'超出服务半径的测试地址'});
  await assert.rejects(()=>service.quote(users.customer,input(21,{addressId:far.id})),/不服务所选地址/);
 });
});
