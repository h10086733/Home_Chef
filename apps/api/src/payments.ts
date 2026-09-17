import {log,safeError} from '@home-chef/infrastructure';
import {Prisma,PrismaClient,User,Order,PaymentRequest} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import {MvpService} from './support';
import {obj,HOUR} from './service';
import {ApiError,ensure,text} from './errors';
import {WechatPay,loadWechatConfig} from './wechat-pay';
type Tx=Prisma.TransactionClient;
export class PaymentService extends MvpService {
 readonly wx:WechatPay|null;
 constructor(db:PrismaClient,clock=()=>new Date(),provider?:WechatPay|null){super(db,clock);const config=provider===undefined?loadWechatConfig():null;this.wx=provider===undefined?(config?new WechatPay(config):null):provider;}
 gateway(){ensure(this.wx,'PAYMENT_UNAVAILABLE','微信支付尚未开通，请等待平台完成商户配置',503);return this.wx;}
 async bindWechat(user:User,code:unknown){
  const openId=await this.gateway().openId(text(code,'微信登录凭证',256));
  return this.transaction(async tx=>{
   const current=await tx.user.findUniqueOrThrow({where:{id:user.id}}),other=await tx.user.findUnique({where:{openId}});
   ensure(!other||other.id===user.id,'WECHAT_BOUND','该微信已绑定其他账号，请登录原账号');
   ensure(!current.openId||current.openId===openId,'WECHAT_BOUND','当前账号已绑定其他微信，请使用原微信付款');
   await tx.user.update({where:{id:user.id},data:{openId}});await this.audit(tx,user.id,'WECHAT_BOUND',user.id);return {bound:true};
  });
 }
 validatePayoutMode(_details:any,_mode:string){}
 async prepay(user:User,orderId:string,choice:unknown,changeId?:unknown){
  const wx=this.gateway();ensure(['DEPOSIT','FULL_PAYMENT','BALANCE','ADDITIONAL'].includes(String(choice)),'PAYMENT_CHOICE','请选择定金、全款或尾款',400);
  const p=await this.transaction(async tx=>{
   const o=await tx.order.findUnique({where:{id:orderId}});ensure(o?.customerId===user.id,'NOT_FOUND','订单不存在',404);
   const account=await tx.user.findUniqueOrThrow({where:{id:user.id}});ensure(account.openId,'WECHAT_LOGIN','请先绑定微信账号');
   const d=obj(o.details),additional=choice==='ADDITIONAL',initial=!additional&&choice!=='BALANCE';
   ensure(o.aftersaleStatus==='NONE'&&(additional||!d.pendingChange),'DISPUTED','请先处理订单售后或变更');
   if(additional)ensure(o.contractStatus==='ACCEPTED'&&['READY','DEPARTED','ARRIVED','SERVING'].includes(o.fulfillmentStatus)&&d.ingredientMode==='CHEF'&&d.pendingChange?.kind==='BUDGET'&&d.pendingChange.id===changeId&&d.pendingChange.createdBy!==user.id&&d.pendingChange.ingredientFen-d.ingredientFen===d.pendingChange.additionalFen,'CHANGE_NOT_PAYABLE','采购变更不存在或已失效');
   if(initial){ensure(o.contractStatus==='PENDING_PAYMENT'&&o.receivedFen===0,'NOT_PAYABLE','当前订单不可支付首款');ensure(new Date(d.paymentDeadline).getTime()>this.clock().getTime()+90000,'QUOTE_EXPIRED','付款期限不足，请重新下单');if(d.mode==='SELF')ensure(await this.available(tx,d.selectedChefId,d,o.quoteId),'SCHEDULE_CONFLICT','当前档期不可用');}
   else if(!additional)ensure(['ACCEPTED','FULFILLED'].includes(o.contractStatus)&&o.feeStatus==='AWAITING_PAYMENT'&&o.balanceFen>0,'NOT_PAYABLE','请先确认最终费用');
   const amountFen=additional?d.pendingChange.additionalFen:choice==='DEPOSIT'?o.depositFen:choice==='FULL_PAYMENT'?o.totalFen:o.balanceFen;
   ensure(Number.isSafeInteger(amountFen)&&amountFen>0,'INVALID_AMOUNT','支付金额无效');
   const old=await tx.paymentRequest.findFirst({where:{orderId,provider:'wechat',kind:{not:'REFUND'},status:{in:['CREATED','PROCESSING']}}});
   if(old){ensure(old.kind===choice&&(!additional||obj(old.rawEvent).changeId===changeId)&&old.amountFen===amountFen&&obj(old.rawEvent).openId===account.openId,'PAYMENT_PENDING','已有支付请求处理中，请继续原支付或等待关单');ensure(new Date(obj(old.rawEvent).expiresAt)>this.clock(),'PAYMENT_PENDING','正在关闭过期支付，请稍后重试');return old;}
      const payoutMode=d.payoutMode??(process.env.WECHAT_PROFITSHARING_ENABLED==='true'?'PROFITSHARING':'TRANSFER');
   this.validatePayoutMode(additional?{...d,ingredientFen:d.pendingChange.ingredientFen}:d,payoutMode);
   if(!d.payoutMode)await tx.order.update({where:{id:orderId},data:{details:{...d,payoutMode}}});
   const expiresAt=initial?new Date(d.paymentDeadline):new Date(this.clock().getTime()+30*60000);
   return tx.paymentRequest.create({data:{orderId,kind:choice as 'DEPOSIT'|'FULL_PAYMENT'|'BALANCE'|'ADDITIONAL',amountFen,idempotencyKey:'wx:'+randomUUID(),provider:'wechat',rawEvent:{...(additional?{changeId:d.pendingChange.id,ingredientFen:d.pendingChange.ingredientFen}:{}),profitSharing:payoutMode==='PROFITSHARING',openId:account.openId,appId:wx.config.appId,mchId:wx.config.mchId,expiresAt:expiresAt.toISOString()}}});
  });
  let prepayId=obj(p.rawEvent).prepayId;
  if(!prepayId){const result=await wx.request('POST','/v3/pay/transactions/jsapi',{appid:wx.config.appId,mchid:wx.config.mchId,description:p.kind==='ADDITIONAL'?'家厨采购费用补款':p.kind==='BALANCE'?'家厨上门服务尾款':'家厨上门服务预约',out_trade_no:p.id,time_expire:obj(p.rawEvent).expiresAt,notify_url:wx.config.notifyUrl,settle_info:{profit_sharing:obj(p.rawEvent).profitSharing===true},amount:{total:p.amountFen,currency:'CNY'},payer:{openid:obj(p.rawEvent).openId}});
   ensure(typeof result.prepay_id==='string','WECHAT_RESPONSE','微信未返回预支付凭证',502);prepayId=result.prepay_id;
   await this.transaction(async tx=>{const current=await tx.paymentRequest.findUniqueOrThrow({where:{id:p.id}});if(['CREATED','PROCESSING'].includes(current.status))await tx.paymentRequest.update({where:{id:p.id},data:{status:'PROCESSING',rawEvent:{...obj(current.rawEvent),prepayId}}});});
  }
  const current=await this.db.order.findUniqueOrThrow({where:{id:orderId}});ensure(current.contractStatus!=='CANCELLED','ORDER_CANCELLED','订单已取消，请勿付款');
  log('info','payment.prepared',{paymentId:p.id,orderId,kind:p.kind});return {paymentId:p.id,amountFen:p.amountFen,...wx.clientParams(prepayId)};
 }
 async paymentStatus(user:User,id:string){
  const p=await this.db.paymentRequest.findUnique({where:{id},include:{order:true}});ensure(p?.order.customerId===user.id&&p.provider==='wechat'&&p.kind!=='REFUND','NOT_FOUND','支付记录不存在',404);
  if(['CREATED','PROCESSING'].includes(p.status))await this.reconcilePayment(p);
  const fresh=await this.db.paymentRequest.findUniqueOrThrow({where:{id}});const refund=await this.db.paymentRequest.findFirst({where:{orderId:p.orderId,kind:'REFUND',rawEvent:{path:['paymentId'],equals:id}}});return {paymentId:id,status:fresh.status,refundRequired:!!refund,order:await this.getOrder(user,p.orderId)};
 }
 async paymentNotification(headers:Record<string,any>,raw:string){const event=this.gateway().notification(headers,raw);await this.recordPayment(event);log('info','payment.callback.accepted',{paymentId:event.out_trade_no});}
 async recordPayment(event:any){
  const wx=this.gateway();ensure(event.trade_state==='SUCCESS'&&event.trade_type==='JSAPI'&&event.appid===wx.config.appId&&event.mchid===wx.config.mchId&&typeof event.transaction_id==='string','WECHAT_TRANSACTION','微信交易信息不匹配',400);
  return this.transaction(async tx=>{
   const p=await tx.paymentRequest.findUnique({where:{id:event.out_trade_no}});ensure(p?.provider==='wechat'&&p.kind!=='REFUND','WECHAT_TRANSACTION','支付记录不存在',400);
   const meta=obj(p.rawEvent);ensure(event.amount?.total===p.amountFen&&event.amount?.currency==='CNY'&&event.payer?.openid===meta.openId&&event.appid===meta.appId&&event.mchid===meta.mchId,'WECHAT_AMOUNT','微信支付金额或付款人不匹配',400);
   if(p.status==='SUCCEEDED'){ensure(p.providerRef===event.transaction_id,'WECHAT_TRANSACTION','微信交易号不匹配',400);return;}
   const duplicate=await tx.paymentRequest.findFirst({where:{provider:'wechat',providerRef:event.transaction_id,kind:{not:'REFUND'},id:{not:p.id}}});ensure(!duplicate,'WECHAT_TRANSACTION','微信交易号重复',400);
   let o=await tx.order.findUniqueOrThrow({where:{id:p.orderId}});const d=obj(o.details);
   await tx.paymentRequest.update({where:{id:p.id},data:{status:'SUCCEEDED',providerRef:event.transaction_id,rawEvent:{...meta,successTime:event.success_time,transactionId:event.transaction_id}}});
   await tx.ledgerEntry.create({data:{orderId:o.id,reference:p.id,kind:'PAYMENT',amountFen:p.amountFen}});
   const beforePayment=o,receivedFen=o.receivedFen+p.amountFen;
   let valid=p.kind==='ADDITIONAL'?o.contractStatus==='ACCEPTED'&&['READY','DEPARTED','ARRIVED','SERVING'].includes(o.fulfillmentStatus)&&o.aftersaleStatus==='NONE'&&d.pendingChange?.kind==='BUDGET'&&d.pendingChange.id===meta.changeId&&d.pendingChange.additionalFen===p.amountFen&&d.pendingChange.ingredientFen===meta.ingredientFen&&meta.ingredientFen-d.ingredientFen===p.amountFen:p.kind==='BALANCE'?['ACCEPTED','FULFILLED'].includes(o.contractStatus)&&o.feeStatus==='AWAITING_PAYMENT'&&o.balanceFen===p.amountFen&&o.aftersaleStatus==='NONE'&&!d.pendingChange:o.contractStatus==='PENDING_PAYMENT'&&o.receivedFen===0&&new Date(d.paymentDeadline)>this.clock();
   const candidates:any[]=[];let coupon:any=null;
   if(valid&&!['BALANCE','ADDITIONAL'].includes(p.kind)){
    if(d.couponId){coupon=await tx.coupon.findUnique({where:{id:d.couponId}});valid=coupon?.status==='AVAILABLE'&&coupon.expiresAt>this.clock();}
    const chefs=await tx.chef.findMany({where:{...(d.mode==='SELF'?{id:d.selectedChefId}:{}),acceptingOrders:true}});
    for(const c of chefs)if(await this.available(tx,c.id,d,o.quoteId))candidates.push({chef:c,distanceM:this.distance(d.latitude,d.longitude,obj(c.data).latitude,obj(c.data).longitude)});
    candidates.sort((a,b)=>a.distanceM-b.distanceM);valid=valid&&candidates.length>0;
   }
   o=await tx.order.update({where:{id:o.id},data:{receivedFen,paymentStatus:p.kind==='DEPOSIT'?'DEPOSIT_PAID':'FULLY_PAID',balanceFen:Math.max(0,o.totalFen-receivedFen)}});
   if(!valid){
        const keepExisting=beforePayment.receivedFen>0&&beforePayment.contractStatus!=='CANCELLED';
    o=await tx.order.update({where:{id:o.id},data:keepExisting?{contractStatus:beforePayment.contractStatus,balanceFen:beforePayment.balanceFen,paymentStatus:beforePayment.paymentStatus}:{contractStatus:o.contractStatus==='CANCELLED'?'CANCELLED':'PAYMENT_EXCEPTION',balanceFen:0,settlementStatus:'INELIGIBLE'}});
    await this.queueRefund(tx,o,p.amountFen,'late-payment:'+p.id,p.id);
    await this.audit(tx,null,'WECHAT_PAYMENT_EXCEPTION',o.id,{paymentId:p.id});await this.event(tx,'款项已收到，但订单无法继续，正在原路退款',o);return;
   }
   if(p.kind==='ADDITIONAL')o=await tx.order.update({where:{id:o.id},data:{totalFen:beforePayment.totalFen+p.amountFen,balanceFen:beforePayment.balanceFen,paymentStatus:beforePayment.balanceFen>0?'DEPOSIT_PAID':'FULLY_PAID',details:{...d,ingredientFen:meta.ingredientFen,pendingChange:null}}});
   else if(p.kind==='BALANCE')o=await tx.order.update({where:{id:o.id},data:{balanceFen:0,feeStatus:'SETTLED',settlementStatus:o.confirmedAt?'PENDING':o.settlementStatus}});
   else{
    const q=await tx.quote.findUniqueOrThrow({where:{id:o.quoteId}}),deadline=new Date(this.clock().getTime()+(d.mode==='SELF'?5:d.rules.matchMinutes)*60000);
    o=await tx.order.update({where:{id:o.id},data:{contractStatus:'PENDING_ACCEPTANCE',details:{...d,initialChoice:p.kind,acceptanceDeadline:deadline.toISOString()}}});
    if(coupon)await tx.coupon.update({where:{id:coupon.id},data:{status:'USED',orderId:o.id}});
    await tx.quote.update({where:{id:o.quoteId},data:{status:'PAID'}});
    if(d.mode==='SELF')await tx.bookingLock.upsert({where:{quoteId:o.quoteId},update:{orderId:o.id,expiresAt:null},create:{quoteId:o.quoteId,orderId:o.id,chefId:d.selectedChefId,startsAt:new Date(new Date(d.startsAt).getTime()-HOUR),endsAt:new Date(new Date(d.endsAt).getTime()+HOUR)}});
    for(const c of candidates.slice(0,3))await tx.chefOrder.create({data:{orderId:o.id,chefId:c.chef.id,distanceM:c.distanceM,urgent:d.urgent,ruleVersion:q.ruleVersion,expiresAt:deadline}});
   }
   await this.audit(tx,o.customerId,'WECHAT_PAYMENT_SUCCEEDED',o.id,{paymentId:p.id,amountFen:p.amountFen});await this.event(tx,p.kind==='ADDITIONAL'?'采购补款到账，新增预算已生效':p.kind==='BALANCE'?'尾款到账':'首付款到账，等待厨师接单',o,candidates.slice(0,3).map(c=>c.chef.userId));
  });
 }
 async queueRefund(tx:Tx,o:Order,amountFen:number,key:string,onlyPayment?:string){
  ensure(Number.isSafeInteger(amountFen)&&amountFen>=0&&amountFen<=o.receivedFen-o.refundedFen,'INVALID_REFUND','退款金额无效');
  if(await tx.paymentRequest.findFirst({where:{orderId:o.id,kind:'REFUND',idempotencyKey:{startsWith:key+'|'}}}))return;
  const refunds=await tx.paymentRequest.findMany({where:{orderId:o.id,kind:'REFUND',provider:'wechat'}});
  const pending=refunds.filter(r=>r.status!=='SUCCEEDED').reduce((s,r)=>s+r.amountFen,0);
  let remaining=onlyPayment?amountFen:Math.max(0,amountFen-pending);
  const payments=await tx.paymentRequest.findMany({where:{orderId:o.id,provider:'wechat',kind:{not:'REFUND'},status:'SUCCEEDED',...(onlyPayment?{id:onlyPayment}:{})},orderBy:{createdAt:'asc'}});
  for(const p of payments){const reserved=refunds.filter(r=>obj(r.rawEvent).paymentId===p.id).reduce((s,r)=>s+r.amountFen,0),amount=Math.min(remaining,p.amountFen-reserved);if(amount<=0)continue;
   await tx.paymentRequest.create({data:{orderId:o.id,kind:'REFUND',amountFen:amount,provider:'wechat',idempotencyKey:key+'|'+p.id,rawEvent:{paymentId:p.id,transactionId:p.providerRef,totalFen:p.amountFen}}});remaining-=amount;
  }
  ensure(remaining===0,'REFUND_ALLOCATION','找不到足够的可退款支付记录');
  await this.audit(tx,null,'WECHAT_REFUND_QUEUED',o.id,{amountFen});await this.event(tx,'退款申请已受理，到账结果以微信处理结果为准',o);
 }
 override async refund(tx:Tx,o:Order,amountFen:number,key:string){
  if(process.env.APP_MODE==='sandbox')return super.refund(tx,o,amountFen,key);
  if(amountFen===0)return;this.gateway();await this.queueRefund(tx,o,amountFen,key);
 }
 async reconcilePayment(p:PaymentRequest){
  const wx=this.gateway();let r:any;
  try{r=await wx.request('GET','/v3/pay/transactions/out-trade-no/'+p.id+'?mchid='+encodeURIComponent(wx.config.mchId));}catch(e){
   // A request whose creation result was lost may not exist yet. Keep it retriable until local expiry.
   if(e instanceof ApiError&&e.code==='WECHAT_ORDER_NOT_EXIST'){
    if(new Date(obj(p.rawEvent).expiresAt)<=this.clock())await this.db.paymentRequest.updateMany({where:{id:p.id,status:{in:['CREATED','PROCESSING']}},data:{status:'EXPIRED'}});return;
   }throw e;
  }
  ensure(r.out_trade_no===p.id&&r.mchid===wx.config.mchId&&r.appid===wx.config.appId,'WECHAT_TRANSACTION','微信查单信息不匹配',502);
  if(r.trade_state==='SUCCESS'){await this.recordPayment(r);return;}
  if(['CLOSED','REVOKED','PAYERROR'].includes(r.trade_state)){await this.db.paymentRequest.updateMany({where:{id:p.id,status:{in:['CREATED','PROCESSING']}},data:{status:'EXPIRED'}});return;}
  const o=await this.db.order.findUniqueOrThrow({where:{id:p.orderId}});
  if(r.trade_state==='NOTPAY'&&(o.contractStatus==='CANCELLED'||(p.kind==='ADDITIONAL'&&(obj(o.details).pendingChange?.id!==obj(p.rawEvent).changeId||o.aftersaleStatus!=='NONE'))||new Date(obj(p.rawEvent).expiresAt)<=this.clock())){
   await wx.request('POST','/v3/pay/transactions/out-trade-no/'+p.id+'/close',{mchid:wx.config.mchId});
   await this.db.paymentRequest.updateMany({where:{id:p.id,status:{in:['CREATED','PROCESSING']}},data:{status:'EXPIRED'}});
  }
 }
 async reconcileRefund(p:PaymentRequest){
  const wx=this.gateway(),m=obj(p.rawEvent);let result:any;
  try{result=await wx.request('GET','/v3/refund/domestic/refunds/'+p.id);}catch(e){
   if(!(e instanceof ApiError)||e.code!=='WECHAT_RESOURCE_NOT_EXISTS')throw e;
   result=await wx.request('POST','/v3/refund/domestic/refunds',{transaction_id:m.transactionId,out_refund_no:p.id,reason:'订单取消或费用调整',amount:{refund:p.amountFen,total:m.totalFen,currency:'CNY'}});
  }
  ensure(result.out_refund_no===p.id&&result.transaction_id===m.transactionId&&result.amount?.refund===p.amountFen&&result.amount?.total===m.totalFen&&result.amount?.currency==='CNY','WECHAT_REFUND','微信退款信息不匹配',502);
  await this.transaction(async tx=>{
   const current=await tx.paymentRequest.findUniqueOrThrow({where:{id:p.id}});if(current.status==='SUCCEEDED')return;
   const success=result.status==='SUCCESS';
   await tx.paymentRequest.update({where:{id:p.id},data:{status:success?'SUCCEEDED':['CLOSED','ABNORMAL'].includes(result.status)?'FAILED':'PROCESSING',providerRef:result.refund_id,rawEvent:{...obj(current.rawEvent),refundStatus:result.status}}});
   if(!success){if(['CLOSED','ABNORMAL'].includes(result.status)&&obj(current.rawEvent).refundStatus!==result.status){await this.audit(tx,null,'WECHAT_REFUND_REQUIRES_ATTENTION',p.orderId,{paymentId:p.id,status:result.status});const o=await tx.order.findUniqueOrThrow({where:{id:p.orderId}});await this.event(tx,'退款渠道处理异常，请联系客服跟进',o);}return;}
   const o=await tx.order.findUniqueOrThrow({where:{id:p.orderId}}),refundedFen=o.refundedFen+p.amountFen;ensure(refundedFen<=o.receivedFen,'INVALID_REFUND','累计退款超出实收');
   await tx.ledgerEntry.create({data:{orderId:o.id,reference:p.id,kind:'REFUND',amountFen:-p.amountFen}});
   const full=refundedFen===o.receivedFen;
   const updated=await tx.order.update({where:{id:o.id},data:{refundedFen,paymentStatus:full?'FULLY_REFUNDED':'PARTIALLY_REFUNDED',...(full&&o.contractStatus==='PAYMENT_EXCEPTION'?{contractStatus:'CANCELLED',balanceFen:0,fulfillmentStatus:'STOPPED',settlementStatus:'INELIGIBLE'}:{})}});
   if(full&&o.contractStatus==='PAYMENT_EXCEPTION'){await tx.bookingLock.deleteMany({where:{orderId:o.id}});await tx.chefOrder.updateMany({where:{orderId:o.id},data:{status:'EXPIRED'}});await tx.quote.update({where:{id:o.quoteId},data:{status:'CANCELLED'}});await tx.coupon.updateMany({where:{orderId:o.id},data:{status:'AVAILABLE',orderId:null}});}
   await this.audit(tx,null,'WECHAT_REFUND_SUCCEEDED',o.id,{paymentId:p.id,amountFen:p.amountFen});await this.event(tx,'微信原路退款已完成',updated);
  });
 }
 private processing=false;
 override async tick(){
  if(this.processing)return {expired:0,confirmed:0,published:0};this.processing=true;
  try{
   if(this.wx){
    const pending=await this.db.paymentRequest.findMany({where:{provider:'wechat',OR:[{status:{in:['CREATED','PROCESSING']}},{kind:'REFUND',status:'FAILED',updatedAt:{lt:new Date(this.clock().getTime()-5*60000)}}]},orderBy:{updatedAt:'asc'},take:5});
    await Promise.all(pending.map(async p=>{try{if(p.kind==='REFUND')await this.reconcileRefund(p);else await this.reconcilePayment(p);}catch(e){log('warn','payment.reconcile_pending',{paymentId:p.id,orderId:p.orderId,kind:p.kind,...safeError(e)});}
     await this.db.paymentRequest.updateMany({where:{id:p.id,status:{in:['CREATED','PROCESSING','FAILED']}},data:{updatedAt:this.clock()}});
    }));
   }
   return await super.tick();
  }finally{this.processing=false;}
 }
 override async viewOrder(tx:Tx,user:User,order:Order){const result=await super.viewOrder(tx,user,order);const payments=await tx.paymentRequest.findMany({where:{orderId:order.id,provider:'wechat'},select:{id:true,kind:true,amountFen:true,status:true,createdAt:true}});return {...result,payments};}
}