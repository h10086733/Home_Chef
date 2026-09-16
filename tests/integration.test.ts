import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {MvpService} from '../apps/api/src/support';
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
 await db.platformRule.create({data:{id:ruleId,publishedBy:users.operator.id,data:{sandbox:true,regions:[{code:prefix,name:'测试片区',active:true}],radiusM:3000,matchMinutes:10,urgentMinMinutes:30,commissionRate:.15,couponEnabled:true,couponFen:2000,couponMinFen:20000}}});
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
  await service.publishRules(users.operator,{...q.details.rules,commissionRate:.2,reason:'测试规则版本'});
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
  const settled=await service.settle(users.finance,o.id);assert.equal((settled as any).chefFen,34000);
  await service.settle(users.finance,o.id);assert.equal(await db.ledgerEntry.count({where:{reference:'settlement:'+o.id}}),1);
  await service.review(users.customer,o.id,{taste:5,service:4,punctuality:5,body:'家宴满意'});
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
 await t.test('72h confirmation does not auto-charge balance; outbox deliveries deduplicate',async()=>{
  const q=await service.quote(users.customer,input(11)),o=await pay(q);await service.accept(users.chef0,o.id);
  const previous=now;now=new Date(q.details.startsAt);
  for(const action of['depart','arrive','start'])await service.fulfill(users.chef0,o.id,{action,evidence:'记录'});
  const a=await service.upload(users.chef0,{orderId:o.id,mime:'image/png',base64:png});
  await service.fulfill(users.chef0,o.id,{action:'complete',evidence:'完成',assetId:a.id,actualIngredientFen:0});
  now=new Date(now.getTime()+72*3600000);await service.tick();const row=await db.order.findUniqueOrThrow({where:{id:o.id}});
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
});
