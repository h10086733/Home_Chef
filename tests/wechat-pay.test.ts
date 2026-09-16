import {ChefFinanceService} from '../apps/api/src/chef-finance';
import {constants,privateDecrypt} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createCipheriv,generateKeyPairSync,randomUUID,sign,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {PrismaClient} from '@prisma/client';
import {WechatPay,WechatConfig} from '../apps/api/src/wechat-pay';
import {PaymentService} from '../apps/api/src/payments';
assert(new URL(process.env.DATABASE_URL!).pathname==='/home_chef_test_wechat','Payment tests must use the isolated database');
process.env.APP_MODE='business';
const db=new PrismaClient();after(()=>db.$disconnect());
const merchant=generateKeyPairSync('rsa',{modulusLength:2048}),platform=generateKeyPairSync('rsa',{modulusLength:2048});
const config:WechatConfig={appId:'wx1234567890abcdef',appSecret:'isolated-test-only',mchId:'1234567890',serial:'TESTSERIAL',privateKey:merchant.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey:platform.publicKey.export({format:'pem',type:'spki'}).toString(),publicKeyId:'PUB_KEY_ID_TEST',apiKey:'12345678901234567890123456789012',notifyUrl:'https://example.invalid/api/payments/wechat/notify'};
function signed(raw:string){const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();return {'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-serial':config.publicKeyId,'wechatpay-signature':sign('RSA-SHA256',Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`),platform.privateKey).toString('base64')};}
const transfers=new Map<string,any>(),shares=new Map<string,any>();let loseTransfer=false;const trades=new Map<string,any>(),refunds=new Map<string,any>();let openId='openid-'+randomUUID(),loseResponse=false;
const transport:typeof fetch=async(input,init)=>{
 const url=new URL(String(input));if(url.hostname==='api.weixin.qq.com')return new Response(JSON.stringify({openid:openId,session_key:'never-return-this'}));
 assert.equal(url.hostname,'api.mch.weixin.qq.com');const auth=(init!.headers as any).Authorization;
 const fields=Object.fromEntries([...auth.matchAll(/(\w+)="([^"]+)"/g)].map((m:any)=>[m[1],m[2]]));
 assert.equal(fields.mchid,config.mchId);assert(verify('RSA-SHA256',Buffer.from(`${init!.method}\n${url.pathname+url.search}\n${fields.timestamp}\n${fields.nonce_str}\n${init!.body??''}\n`),merchant.publicKey,Buffer.from(fields.signature,'base64')));
 const body=init?.body?JSON.parse(String(init.body)):null;let result:any,status=200;
 if(url.pathname.startsWith('/v3/fund-app/mch-transfer/transfer-bills')){
  if(init!.method==='POST'){const name=privateDecrypt({key:platform.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},Buffer.from(body.user_name,'base64')).toString();assert.equal(name,'测试厨师');const id=body.out_bill_no;
   if(!transfers.has(id))transfers.set(id,{mch_id:config.mchId,out_bill_no:id,transfer_bill_no:'transfer'+id,appid:body.appid,openid:body.openid,transfer_amount:body.transfer_amount,state:'WAIT_USER_CONFIRM',package_info:'confirmation-'+id});result=transfers.get(id);if(loseTransfer){loseTransfer=false;throw new Error('Lost transfer response after remote commit');}
  }else{result=transfers.get(url.pathname.split('/').at(-1)!);if(!result){status=404;result={code:'NOT_FOUND'};}}
 }else if(url.pathname==='/v3/profitsharing/receivers/add'){assert.equal(privateDecrypt({key:platform.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},Buffer.from(body.name,'base64')).toString(),'测试厨师');result={type:body.type,account:body.account};}
 else if(url.pathname.startsWith('/v3/profitsharing/orders')){
  if(init!.method==='POST'){const id=body.out_order_no;assert.equal(body.unfreeze_unsplit,true);if(!shares.has(id))shares.set(id,{out_order_no:id,transaction_id:body.transaction_id,order_id:'share'+id,state:'PROCESSING',receivers:body.receivers.map((r:any)=>({...r,result:'PENDING'}))});result=shares.get(id);}
  else{result=shares.get(url.pathname.split('/').at(-1)!);if(!result){status=404;result={code:'RESOURCE_NOT_EXISTS'};}}
 }else if(url.pathname==='/v3/pay/transactions/jsapi'){
  assert(body.amount.total>0);const id=body.out_trade_no;
  if(!trades.has(id))trades.set(id,{out_trade_no:id,appid:body.appid,mchid:body.mchid,amount:body.amount,payer:body.payer,trade_state:'NOTPAY',trade_type:'JSAPI',transaction_id:'tx'+id,success_time:new Date().toISOString()});
  result={prepay_id:'prepay-'+id};if(loseResponse){loseResponse=false;throw new Error('Connection lost after remote commit');}
 }else if(url.pathname.endsWith('/close')){const id=url.pathname.split('/').at(-2)!;assert.equal(trades.get(id).trade_state,'NOTPAY');trades.get(id).trade_state='CLOSED';result=undefined;status=204;}
 else if(url.pathname.includes('/transactions/out-trade-no/')){result=trades.get(url.pathname.split('/').at(-1)!);if(!result){status=404;result={code:'ORDER_NOT_EXIST'};}}
 else if(init!.method==='POST'&&url.pathname==='/v3/refund/domestic/refunds'){result={out_refund_no:body.out_refund_no,transaction_id:body.transaction_id,refund_id:'rf'+body.out_refund_no,amount:body.amount,status:'PROCESSING'};refunds.set(body.out_refund_no,result);}
 else{result=refunds.get(url.pathname.split('/').at(-1)!);if(!result){status=404;result={code:'RESOURCE_NOT_EXISTS'};}}
 const raw=result===undefined?'':JSON.stringify(result);return new Response(status===204?null:raw,{status,headers:signed(raw)});
};
const wx=new WechatPay(config,transport),svc=new PaymentService(db,()=>new Date(),wx);
function notification(event:any){const nonce='123456789012',aad='transaction',cipher=createCipheriv('aes-256-gcm',Buffer.from(config.apiKey),nonce);cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(event)),cipher.final(),cipher.getAuthTag()]).toString('base64');const raw=JSON.stringify({event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',original_type:'transaction',nonce,associated_data:aad,ciphertext}});return {raw,headers:signed(raw)};}
test('WeChat APIv3 payment, isolated database and signed transport',async t=>{
 const f=JSON.parse(readFileSync('.data/business-fixture.json','utf8')),prefix='wx'+randomUUID().replaceAll('-','').slice(0,12),password='PaymentTest2026!';
 const auth=await svc.login({username:prefix,password,displayName:'隔离支付测试'},true),user=await svc.session(auth.token);
 const strangerAuth=await svc.login({username:prefix+'x',password,displayName:'隔离权限测试'},true),stranger=await svc.session(strangerAuth.token);
 const address=await svc.address(user,{label:'隔离地址',regionCode:f.regionCode,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'支付自动化测试地址'});
 const created:string[]=[];t.after(async()=>{await db.bookingLock.deleteMany({where:{orderId:{in:created}}});await db.order.updateMany({where:{id:{in:created},contractStatus:{in:['PENDING_PAYMENT','PENDING_ACCEPTANCE']}},data:{contractStatus:'CANCELLED'}});});let index=0;
 const order=async()=>{const startsAt=new Date(Date.now()+(5+index++)*86400000);startsAt.setHours(18,0,0,0);const q=await svc.quote(user,{packageId:f.packages[0],addressId:address.id,startsAt:startsAt.toISOString(),guests:3,children:0,elders:0,allergens:'无',kitchen:'可用',cuisine:'湘菜',ingredientMode:'CUSTOMER',mode:'SELF',hours:2});const o=await svc.submitQuote(user,q.id);created.push(o.id);return o;};
 await t.test('missing configuration blocks payments; binding is unique and does not expose session keys',async()=>{
  const disabled=new PaymentService(db,()=>new Date(),null);await assert.rejects(()=>disabled.prepay(user,'missing','DEPOSIT'),/尚未开通/);
  assert.deepEqual(await svc.bindWechat(user,'code'),{bound:true});await assert.rejects(()=>svc.bindWechat(stranger,'code'),/已绑定其他账号/);
  openId='different-openid';await assert.rejects(()=>svc.bindWechat(user,'code'),/已绑定其他微信/);openId=(await db.user.findUniqueOrThrow({where:{id:user.id}})).openId!;
 });
 let o:any,p:any;
 await t.test('server amount, access control and concurrent prepay reuse one merchant order',async()=>{
  o=await order();await assert.rejects(()=>svc.prepay(stranger,o.id,'DEPOSIT'),/不存在/);
  const pair=await Promise.all([svc.prepay(user,o.id,'DEPOSIT'),svc.prepay(user,o.id,'DEPOSIT')]);p=pair[0];assert.equal(p.paymentId,pair[1].paymentId);assert.equal(p.amountFen,o.depositFen);
  assert(verify('RSA-SHA256',Buffer.from(`${config.appId}\n${p.timeStamp}\n${p.nonceStr}\n${p.package}\n`),merchant.publicKey,Buffer.from(p.paySign,'base64')));
  assert.equal((await db.order.findUniqueOrThrow({where:{id:o.id}})).receivedFen,0);assert.equal(await db.ledgerEntry.count({where:{orderId:o.id}}),0);
  await assert.rejects(()=>svc.prepay(user,o.id,'FULL_PAYMENT'),/已有支付请求/);await assert.rejects(()=>svc.paymentStatus(stranger,p.paymentId),/不存在/);
 });
 await t.test('forged, stale, wrong-serial, altered-body, wrong-amount and wrong-payer events are rejected',async()=>{
  const event={...trades.get(p.paymentId),trade_state:'SUCCESS'},n=notification(event);
  assert.throws(()=>wx.notification({...n.headers,'wechatpay-signature':'forged'},n.raw));assert.throws(()=>wx.notification({...n.headers,'wechatpay-timestamp':'1'},n.raw));assert.throws(()=>wx.notification({...n.headers,'wechatpay-serial':'other'},n.raw));assert.throws(()=>wx.notification(n.headers,n.raw+' '));
  for(const invalid of [{...event,amount:{total:1,currency:'CNY'}},{...event,payer:{openid:'other'}},{...event,mchid:'other'}]){const bad=notification(invalid);await assert.rejects(()=>svc.paymentNotification(bad.headers,bad.raw));}
  assert.equal((await db.order.findUniqueOrThrow({where:{id:o.id}})).receivedFen,0);
 });
 await t.test('duplicate signed notification credits once, activates chef invitation, never fabricates insurance',async()=>{
  const event=trades.get(p.paymentId);event.trade_state='SUCCESS';const n=notification(event);await Promise.all([svc.paymentNotification(n.headers,n.raw),svc.paymentNotification(n.headers,n.raw)]);
  const paid=await svc.getOrder(user,o.id);assert.equal(paid.receivedFen,o.depositFen);assert.equal(paid.contractStatus,'PENDING_ACCEPTANCE');assert.equal(paid.paymentStatus,'DEPOSIT_PAID');assert.equal(await db.ledgerEntry.count({where:{orderId:o.id,kind:'PAYMENT'}}),1);assert.equal(await db.insurancePolicy.count({where:{orderId:o.id}}),0);assert.equal(await db.chefOrder.count({where:{orderId:o.id}}),1);
 });
 await t.test('actual HTTP endpoint verifies unmodified raw body before authentication and rejects tampering',async()=>{
  const dir=await mkdtemp(resolve('.data/wx-http-')),keyPath=resolve(dir,'merchant.pem'),publicPath=resolve(dir,'public.pem');await writeFile(keyPath,config.privateKey,{mode:0o600});await writeFile(publicPath,config.publicKey);
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));
  const child=spawn(process.execPath,['--import','tsx','src/main.ts'],{cwd:resolve('apps/api'),env:{...process.env,PORT:String(port),HOST:'127.0.0.1',WECHAT_PAY_ENABLED:'true',WECHAT_APP_ID:config.appId,WECHAT_APP_SECRET:config.appSecret,WECHAT_MCH_ID:config.mchId,WECHAT_MCH_SERIAL:config.serial,WECHAT_MCH_PRIVATE_KEY_PATH:keyPath,WECHAT_API_V3_KEY:config.apiKey,WECHAT_PAY_PUBLIC_KEY_ID:config.publicKeyId,WECHAT_PAY_PUBLIC_KEY_PATH:publicPath,WECHAT_PAY_NOTIFY_URL:config.notifyUrl},stdio:'ignore'});
  try{
   let ready=false;for(let i=0;i<60;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,'HTTP API starts');
   const n=notification(trades.get(p.paymentId)),raw=n.raw+'\n',headers={...signed(raw),'Content-Type':'application/json'};
   const ok=await fetch(`http://127.0.0.1:${port}/api/payments/wechat/notify`,{method:'POST',headers,body:raw});assert.equal(ok.status,204);
   const invalid=await fetch(`http://127.0.0.1:${port}/api/payments/wechat/notify`,{method:'POST',headers,body:n.raw});assert.equal(invalid.status,401);
   assert.equal(await db.ledgerEntry.count({where:{orderId:o.id,kind:'PAYMENT'}}),1);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');await exited;}await rm(dir,{recursive:true,force:true});}
 });
 await t.test('cancellation queues refund, accepted refund is not booked until confirmed; duplicate result is harmless',async()=>{
  await svc.cancel(user,o.id,{reason:'测试退款'});const r=await db.paymentRequest.findFirstOrThrow({where:{orderId:o.id,kind:'REFUND'}});assert.equal((await svc.getOrder(user,o.id)).refundedFen,0);
  await svc.reconcileRefund(r);assert.equal((await svc.getOrder(user,o.id)).refundedFen,0);refunds.get(r.id).status='SUCCESS';await Promise.all([svc.reconcileRefund(r),svc.reconcileRefund(r)]);
  const refunded=await svc.getOrder(user,o.id);assert.equal(refunded.refundedFen,p.amountFen);assert.equal(refunded.paymentStatus,'FULLY_REFUNDED');assert.equal(await db.ledgerEntry.count({where:{orderId:o.id,kind:'REFUND'}}),1);
 });
 await t.test('late payment after cancellation is credited and queued for refund without dispatch',async()=>{
  const o=await order(),p=await svc.prepay(user,o.id,'FULL_PAYMENT');await svc.cancel(user,o.id,{reason:'支付中取消'});trades.get(p.paymentId).trade_state='SUCCESS';await svc.paymentStatus(user,p.paymentId);
  const state=await svc.getOrder(user,o.id);assert.equal(state.contractStatus,'CANCELLED');assert.equal(state.receivedFen,p.amountFen);assert.equal(await db.chefOrder.count({where:{orderId:o.id}}),0);assert.equal(await db.paymentRequest.count({where:{orderId:o.id,kind:'REFUND'}}),1);
 });
 await t.test('response lost after prepay creation reuses merchant number; missing notification is recovered by query',async()=>{
  const o=await order();loseResponse=true;await assert.rejects(()=>svc.prepay(user,o.id,'FULL_PAYMENT'),/暂未响应/);const p=await svc.prepay(user,o.id,'FULL_PAYMENT');assert.equal(await db.paymentRequest.count({where:{orderId:o.id}}),1);
  trades.get(p.paymentId).trade_state='SUCCESS';const status=await svc.paymentStatus(user,p.paymentId);assert.equal(status.status,'SUCCEEDED');assert.equal(status.order.receivedFen,o.totalFen);await svc.cancel(user,o.id,{reason:'清理测试订单'});
 });
 await t.test('unpaid cancelled order is closed remotely',async()=>{
  const o=await order(),p=await svc.prepay(user,o.id,'DEPOSIT');await svc.cancel(user,o.id,{reason:'关单测试'});const s=await svc.paymentStatus(user,p.paymentId);assert.equal(s.status,'EXPIRED');assert.equal(trades.get(p.paymentId).trade_state,'CLOSED');assert.equal(s.order.receivedFen,0);
 });
 await t.test('an additional late capture is refunded without stopping the already-paid booking',async()=>{
  const o=await order(),p=await svc.prepay(user,o.id,'DEPOSIT');trades.get(p.paymentId).trade_state='SUCCESS';await svc.paymentStatus(user,p.paymentId);
  const source=await db.paymentRequest.findUniqueOrThrow({where:{id:p.paymentId}}),extra=await db.paymentRequest.create({data:{orderId:o.id,kind:'DEPOSIT',amountFen:p.amountFen,status:'EXPIRED',provider:'wechat',idempotencyKey:randomUUID(),rawEvent:source.rawEvent!}});
  await svc.recordPayment({...trades.get(p.paymentId),out_trade_no:extra.id,transaction_id:'extra'+extra.id});
  const state=await svc.getOrder(user,o.id);assert.equal(state.contractStatus,'PENDING_ACCEPTANCE');assert.equal(state.balanceFen,o.totalFen-p.amountFen);assert.equal(await db.chefOrder.count({where:{orderId:o.id}}),1);
  const r=await db.paymentRequest.findFirstOrThrow({where:{orderId:o.id,kind:'REFUND'}});await svc.reconcileRefund(r);refunds.get(r.id).status='SUCCESS';await svc.reconcileRefund(r);
  assert.equal((await svc.getOrder(user,o.id)).receivedFen-(await svc.getOrder(user,o.id)).refundedFen,p.amountFen);await svc.cancel(user,o.id,{reason:'测试清理'});
 });
 await t.test('balance uses confirmed database amount and settles only after signed payment',async()=>{
  const o=await order(),p=await svc.prepay(user,o.id,'DEPOSIT');trades.get(p.paymentId).trade_state='SUCCESS';await svc.paymentStatus(user,p.paymentId);
  await db.order.update({where:{id:o.id},data:{contractStatus:'FULFILLED',feeStatus:'AWAITING_PAYMENT',confirmedAt:new Date()}});
  const balance=await svc.prepay(user,o.id,'BALANCE');assert.equal(balance.amountFen,o.totalFen-o.depositFen);trades.get(balance.paymentId).trade_state='SUCCESS';const s=await svc.paymentStatus(user,balance.paymentId);assert.equal(s.order.balanceFen,0);assert.equal(s.order.receivedFen,o.totalFen);assert.equal(s.order.feeStatus,'SETTLED');assert.equal(s.order.settlementStatus,'PENDING');
 });
});
test('Chef settlement, withdrawal and profit sharing',async t=>{
 const f=JSON.parse(readFileSync('.data/business-fixture.json','utf8')),tag='finance'+randomUUID().slice(0,8),password='FinanceTest2026!';
 process.env.WECHAT_TRANSFER_ENABLED='true';process.env.WECHAT_TRANSFER_SCENE_ID='TEST_ONLY';process.env.WECHAT_TRANSFER_SCENE_REPORTS=JSON.stringify([{info_type:'服务类型',info_content:'测试厨师服务'}]);process.env.WECHAT_PROFITSHARING_MAX_RATIO='0.9';
 const finance=new ChefFinanceService(db,()=>new Date(Date.now()+8*86400000),wx),admin=await db.user.create({data:{username:tag+'admin',displayName:'测试财务',roles:['FINANCE']}});
 const customer=await svc.session((await svc.login({username:tag,password,displayName:'财务测试用户'},true)).token);openId='customer-'+tag;await svc.bindWechat(customer,'code');
 const chef=await db.chef.findUniqueOrThrow({where:{id:f.chefs[0]}}),chefUser=await db.user.findUniqueOrThrow({where:{id:chef.userId}});openId='chef-'+tag;await finance.bindWechat(chefUser,'code');await finance.payoutProfile(chefUser,{name:'测试厨师',consent:true});
 const addr=await svc.address(customer,{label:'财务测试',regionCode:f.regionCode,latitude:28.194,longitude:112.961,coordinateSystem:'GCJ02',fullText:'隔离支付测试地址'});let idx=0;const ids:string[]=[];
 t.after(async()=>{process.env.WECHAT_TRANSFER_ENABLED='false';process.env.WECHAT_PROFITSHARING_ENABLED='false';await db.bookingLock.deleteMany({where:{orderId:{in:ids}}});await db.order.updateMany({where:{id:{in:ids},contractStatus:'PENDING_ACCEPTANCE'},data:{contractStatus:'CANCELLED'}});});
 const completeOrder=async(mode='TRANSFER')=>{process.env.WECHAT_PROFITSHARING_ENABLED=mode==='PROFITSHARING'?'true':'false';const startsAt=new Date(Date.now()+(5+idx++)*86400000);startsAt.setHours(18,0,0,0);const q=await svc.quote(customer,{packageId:f.packages[0],addressId:addr.id,startsAt:startsAt.toISOString(),guests:3,children:0,elders:0,allergens:'无',kitchen:'可用',cuisine:'湘菜',ingredientMode:'CUSTOMER',mode:'SELF',hours:2});const o=await svc.submitQuote(customer,q.id);ids.push(o.id);const p=await svc.prepay(customer,o.id,'FULL_PAYMENT');trades.get(p.paymentId).trade_state='SUCCESS';await svc.paymentStatus(customer,p.paymentId);await db.order.update({where:{id:o.id},data:{acceptedChefId:chef.id,contractStatus:'FULFILLED',fulfillmentStatus:'COMPLETED',feeStatus:'SETTLED',settlementStatus:'PENDING',confirmedAt:new Date(),serviceEndsAt:new Date()}});return o;};
 const request=(amountFen:number,key=randomUUID())=>finance.withdraw(chefUser,{amountFen,idempotencyKey:key});
 let o:any,settlement:any;
 await t.test('financial membership is admin-only, forbids self-grant, and cannot grant unrelated roles',async()=>{
  const owner=await db.user.create({data:{username:tag+'owner',roles:['ADMIN']}});
  await assert.rejects(()=>finance.financeRoles(customer,{username:customer.username,role:'FINANCE',enabled:true,reason:'test'}));
  await assert.rejects(()=>finance.financeRoles(owner,{username:owner.username,role:'FINANCE',enabled:true,reason:'test'}));
  await assert.rejects(()=>finance.financeRoles(owner,{username:customer.username,role:'ADMIN',enabled:true,reason:'test'}));
  await finance.financeRoles(owner,{username:customer.username,role:'FINANCE_MANAGER',enabled:true,reason:'隔离测试授权'});assert((await db.user.findUniqueOrThrow({where:{id:customer.id}})).roles.includes('FINANCE_MANAGER'));
  await finance.financeRoles(owner,{username:customer.username,role:'FINANCE_MANAGER',enabled:false,reason:'隔离测试撤销'});assert(!(await db.user.findUniqueOrThrow({where:{id:customer.id}})).roles.includes('FINANCE_MANAGER'));
 });
 await t.test('seven-day hold, financial role, immutable income and idempotent commission allocation',async()=>{
  o=await completeOrder();await assert.rejects(()=>new ChefFinanceService(db,()=>new Date(),wx).settle(admin,o.id),/保护期/);await assert.rejects(()=>finance.settle(customer,o.id));
  const pair=await Promise.all([finance.settle(admin,o.id),finance.settle(admin,o.id)]);settlement=pair[0];assert.equal(pair[0].id,pair[1].id);assert.equal(settlement.chefFen,8330);assert.equal(settlement.commissionFen,1470);assert.equal((await finance.wallet(chefUser)).availableFen,8330);
  await assert.rejects(()=>db.chefWalletEntry.updateMany({where:{chefId:chef.id},data:{amountFen:999999}}));
 });
 await t.test('concurrent withdrawals cannot overdraw; cancellation releases one reservation',async()=>{
  const attempts=await Promise.allSettled([request(5000),request(5000)]);assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);const w=(attempts.find(a=>a.status==='fulfilled') as PromiseFulfilledResult<any>).value;assert.equal((await finance.wallet(chefUser)).availableFen,3330);await finance.withdrawalAction(chefUser,w.id,{action:'cancel'});await assert.rejects(()=>finance.withdrawalAction(chefUser,w.id,{action:'cancel'}));assert.equal((await finance.wallet(chefUser)).availableFen,8330);
 });
 let withdrawal:any;
 await t.test('approval is required, ownership is checked and duplicate requests reserve once',async()=>{
  const key=randomUUID(),a=await request(1000,key),b=await request(1000,key);withdrawal=a;assert.equal(a.id,b.id);await assert.rejects(()=>request(2000,key));await assert.rejects(()=>finance.withdrawalStatus(customer,a.id));await assert.rejects(()=>finance.withdrawalAction(chefUser,a.id,{action:'approve'}));await finance.syncTransfer(a.id);assert.equal(transfers.has(a.id),false);await finance.withdrawalAction(admin,a.id,{action:'approve'});await finance.syncTransfer(a.id);assert.equal((await finance.withdrawalStatus(chefUser,a.id)).status,'WAIT_USER_CONFIRM');assert.equal((await finance.wallet(chefUser)).paidWithdrawalFen,0);assert.equal((await finance.withdrawalStatus(chefUser,a.id)).confirmation?.package,'confirmation-'+a.id);await assert.rejects(()=>finance.withdrawalAction(chefUser,a.id,{action:'cancel'}));
 });
 await t.test('wrong amount callback is rejected; signed success marks paid once without a second balance debit',async()=>{
  const r={...transfers.get(withdrawal.id),state:'SUCCESS'};await assert.rejects(()=>finance.recordTransfer({...r,transfer_amount:1}));
  const nonce='123456789012',aad='mch_payment',cipher=createCipheriv('aes-256-gcm',Buffer.from(config.apiKey),nonce);cipher.setAAD(Buffer.from(aad));const ciphertext=Buffer.concat([cipher.update(JSON.stringify(r)),cipher.final(),cipher.getAuthTag()]).toString('base64');const raw=JSON.stringify({event_type:'MCHTRANSFER.BILL.FINISHED',resource:{algorithm:'AEAD_AES_256_GCM',original_type:aad,nonce,associated_data:aad,ciphertext}});
  await Promise.all([finance.transferNotification(signed(raw),raw),finance.transferNotification(signed(raw),raw)]);assert.equal((await finance.wallet(chefUser)).availableFen,7330);assert.equal((await finance.wallet(chefUser)).paidWithdrawalFen,1000);
 });
 await t.test('definitive failure releases frozen funds exactly once',async()=>{
  const w=await request(500);await finance.withdrawalAction(admin,w.id,{action:'approve'});await finance.syncTransfer(w.id);transfers.get(w.id).state='FAIL';await Promise.all([finance.syncTransfer(w.id),finance.syncTransfer(w.id)]);assert.equal((await finance.wallet(chefUser)).availableFen,7330);assert.equal(await db.chefWalletEntry.count({where:{reference:'release:'+w.id}}),1);
 });
 await t.test('lost transfer response retains reservation and recovers the same merchant bill',async()=>{
  const w=await request(500);await finance.withdrawalAction(admin,w.id,{action:'approve'});loseTransfer=true;await assert.rejects(()=>finance.syncTransfer(w.id));assert.equal((await finance.wallet(chefUser)).availableFen,6830);await finance.syncTransfer(w.id);assert.equal(transfers.get(w.id).out_bill_no,w.id);transfers.get(w.id).state='SUCCESS';await finance.syncTransfer(w.id);assert.equal((await finance.wallet(chefUser)).paidWithdrawalFen,1500);
 });
 await t.test('retry of an undispatched withdrawal rechecks disputes and keeps funds reserved',async()=>{
  const w=await request(100);await finance.withdrawalAction(admin,w.id,{action:'approve'});await db.chefWithdrawal.update({where:{id:w.id},data:{status:'PROCESSING'}});
  const before=(await finance.wallet(chefUser)).availableFen;await db.order.update({where:{id:o.id},data:{aftersaleStatus:'PROCESSING'}});
  try{await assert.rejects(()=>finance.syncTransfer(w.id),/售后/);assert.equal(transfers.has(w.id),false);assert.equal((await finance.wallet(chefUser)).availableFen,before);}finally{await db.order.update({where:{id:o.id},data:{aftersaleStatus:'NONE'}});}
  await finance.syncTransfer(w.id);transfers.get(w.id).state='FAIL';await finance.syncTransfer(w.id);
 });
 await t.test('old unresolved transfer requires review without releasing funds and a signed result still resolves it',async()=>{
  const w=await request(100);await finance.withdrawalAction(admin,w.id,{action:'approve'});await finance.syncTransfer(w.id);const before=(await finance.wallet(chefUser)).availableFen;
  await db.chefWithdrawal.update({where:{id:w.id},data:{createdAt:new Date(Date.now()-31*86400000)}});await finance.syncTransfer(w.id);
  assert.equal((await db.chefWithdrawal.findUniqueOrThrow({where:{id:w.id}})).status,'REVIEW_REQUIRED');assert.equal((await finance.wallet(chefUser)).availableFen,before);
  await finance.recordTransfer({...transfers.get(w.id),state:'FAIL'});assert.equal((await finance.wallet(chefUser)).availableFen,before+100);
  const offline=new ChefFinanceService(db,()=>new Date(),null);assert.equal((await offline.withdrawalStatus(chefUser,w.id)).status,'FAIL');await finance.syncTransfer(w.id);assert.equal((await db.chefWithdrawal.findUniqueOrThrow({where:{id:w.id}})).status,'FAIL');
 });
 await t.test('open dispute and pending refund prevent release of new earnings',async()=>{
  const disputed=await completeOrder();await db.order.update({where:{id:disputed.id},data:{aftersaleStatus:'PROCESSING'}});await assert.rejects(()=>finance.settle(admin,disputed.id));await assert.rejects(()=>request(100));await db.order.update({where:{id:disputed.id},data:{aftersaleStatus:'NONE'}});
  await db.paymentRequest.create({data:{orderId:disputed.id,kind:'REFUND',amountFen:100,provider:'wechat',idempotencyKey:randomUUID()}});await assert.rejects(()=>finance.settle(admin,disputed.id),/退款/);
 });
 await t.test('undispatched profit sharing retry pauses during disputes; closed result cannot regress',async()=>{
  const shared=await completeOrder('PROFITSHARING'),s=await finance.settle(admin,shared.id),task=await db.profitShareTask.findFirstOrThrow({where:{settlementId:s.id}});
  await db.profitShareTask.update({where:{id:task.id},data:{status:'PROCESSING'}});await db.order.update({where:{id:shared.id},data:{aftersaleStatus:'PROCESSING'}});
  await assert.rejects(()=>finance.syncShare(task.id),/争议/);assert.equal(shares.has(task.id),false);await db.order.update({where:{id:shared.id},data:{aftersaleStatus:'NONE'}});
  await finance.syncShare(task.id);shares.get(task.id).state='FINISHED';shares.get(task.id).receivers[0].result='CLOSED';await finance.syncShare(task.id);
  assert.equal((await db.chefSettlement.findUniqueOrThrow({where:{id:s.id}})).status,'ATTENTION');shares.get(task.id).state='PROCESSING';shares.get(task.id).receivers[0].result='PENDING';await finance.syncShare(task.id);
  assert.equal((await db.profitShareTask.findUniqueOrThrow({where:{id:task.id}})).status,'FAILED');assert.equal(await db.ledgerEntry.count({where:{reference:'profitshare:'+task.id}}),0);
 });
 await t.test('direct profit sharing preserves mode, checks approved ratio, never creates withdrawable balance, and confirms once',async()=>{
  const shared=await completeOrder('PROFITSHARING');process.env.WECHAT_PROFITSHARING_MAX_RATIO='0.3';await assert.rejects(()=>finance.settle(admin,shared.id),/获批比例/);assert.equal(await db.chefSettlement.count({where:{orderId:shared.id}}),0);process.env.WECHAT_PROFITSHARING_MAX_RATIO='0.9';const before=(await finance.wallet(chefUser)).availableFen;const s=await finance.settle(admin,shared.id);assert.equal(s.mode,'PROFITSHARING');const task=await db.profitShareTask.findFirstOrThrow({where:{settlementId:s.id}});await finance.syncShare(task.id);assert.equal((await db.chefSettlement.findUniqueOrThrow({where:{id:s.id}})).status,'PROCESSING');shares.get(task.id).state='FINISHED';shares.get(task.id).receivers[0].result='SUCCESS';await Promise.all([finance.syncShare(task.id),finance.syncShare(task.id)]);assert.equal((await db.chefSettlement.findUniqueOrThrow({where:{id:s.id}})).status,'PAID');assert.equal((await finance.wallet(chefUser)).availableFen,before);assert.equal(((await db.order.findUniqueOrThrow({where:{id:shared.id}})).details as any).settlement.status,'PAID');assert.equal(await db.ledgerEntry.count({where:{reference:'profitshare:'+task.id}}),1);await assert.rejects(()=>finance.transaction(tx=>finance.queueRefund(tx,shared,100,'after-share')),/追偿/);
 });
});