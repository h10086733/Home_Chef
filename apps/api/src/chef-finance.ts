import {log,safeError} from '@home-chef/infrastructure';
import {Prisma,User,Order,ChefWithdrawal,ProfitShareTask} from '@prisma/client';
import {PaymentService} from './payments';
import {obj,HOUR} from './service';
import {ApiError,ensure,text,integer} from './errors';
import {encrypt,decrypt} from './security';
type Tx=Prisma.TransactionClient;
const ACTIVE=['REQUESTED','APPROVED','PROCESSING','ACCEPTED','WAIT_USER_CONFIRM','TRANSFERING','CANCELING'];
export class ChefFinanceService extends PaymentService {
 override validatePayoutMode(d:any,mode:string){
  if(mode!=='PROFITSHARING')return;
  const ratio=Number(process.env.WECHAT_PROFITSHARING_MAX_RATIO),total=d.serviceFen+d.ingredientFen-(d.discountFen??0),commission=Math.round(d.serviceFen*d.rules.commissionRate);
  ensure(process.env.WECHAT_PROFITSHARING_ENABLED==='true'&&ratio>0&&ratio<=1,'PROFITSHARING_CONFIG','微信分账权限及比例尚未配置',503);
  ensure(!d.discountFen,'SUBSIDY_UNSUPPORTED','微信直接分账暂不支持平台补贴，请取消优惠券后重新下单');
  ensure(Number.isSafeInteger(total)&&total>0&&(total-commission)/total<=ratio,'PROFITSHARING_LIMIT','服务收入分配超过商户获批的分账比例，暂不能付款');
 }
 holdHours(){const n=Number(process.env.CHEF_SETTLEMENT_HOLD_HOURS??168);ensure(Number.isInteger(n)&&n>=168&&n<=720,'FINANCE_CONFIG','结算保护期配置无效',503);return n;}
 transferConfig(){
  ensure(process.env.WECHAT_TRANSFER_ENABLED==='true','TRANSFER_UNAVAILABLE','微信提现尚未开通',503);const wx=this.gateway();
  const scene=text(process.env.WECHAT_TRANSFER_SCENE_ID,'转账场景配置',32);let reports:any;
  try{reports=JSON.parse(process.env.WECHAT_TRANSFER_SCENE_REPORTS??'');}catch{throw new ApiError(503,'FINANCE_CONFIG','请配置商户已获批的转账场景资料');}
  ensure(Array.isArray(reports)&&reports.length>0&&reports.every(r=>typeof r.info_type==='string'&&r.info_type.length>0&&r.info_type.length<=15&&typeof r.info_content==='string'&&r.info_content.length>0&&r.info_content.length<=32),'FINANCE_CONFIG','转账场景报备配置无效',503);
  const max=Number(process.env.WECHAT_TRANSFER_MAX_FEN??200000);ensure(Number.isSafeInteger(max)&&max>=10&&max<=20000000,'FINANCE_CONFIG','提现限额配置无效',503);
  return {scene,reports,max,notifyUrl:new URL('/api/chef/transfers/notify',wx.config.notifyUrl).href};
 }
 async walletBalance(tx:Tx,chefId:string){return (await tx.chefWalletEntry.aggregate({where:{chefId},_sum:{amountFen:true}}))._sum.amountFen??0;}
 async wallet(user:User){return this.transaction(async tx=>{
  const chef=await tx.chef.findUnique({where:{userId:user.id}});ensure(chef,'NOT_CHEF','请先申请成为厨师');
  const settlements=await tx.chefSettlement.findMany({where:{chefId:chef.id},orderBy:{createdAt:'desc'},take:100});
  const withdrawals=await tx.chefWithdrawal.findMany({where:{chefId:chef.id},orderBy:{createdAt:'desc'},take:100});
  const orders=await tx.order.findMany({where:{acceptedChefId:chef.id,settlementStatus:{in:['PENDING','FROZEN']}}});
  return {chefId:chef.id,availableFen:await this.walletBalance(tx,chef.id),pendingWithdrawalFen:(await tx.chefWithdrawal.aggregate({where:{chefId:chef.id,status:{in:[...ACTIVE,'REVIEW_REQUIRED']}},_sum:{amountFen:true}}))._sum.amountFen??0,paidWithdrawalFen:(await tx.chefWithdrawal.aggregate({where:{chefId:chef.id,status:'SUCCESS'},_sum:{amountFen:true}}))._sum.amountFen??0,transferEnabled:process.env.WECHAT_TRANSFER_ENABLED==='true'&&!!this.wx,holdHours:this.holdHours(),settlements,withdrawals:withdrawals.map(w=>this.safeWithdrawal(w)),pendingOrders:orders.map(o=>({id:o.id,totalFen:o.totalFen,eligibleAt:o.confirmedAt?new Date(o.confirmedAt.getTime()+this.holdHours()*HOUR):null,status:o.settlementStatus})),entries:await tx.chefWalletEntry.findMany({where:{chefId:chef.id},orderBy:{createdAt:'desc'},take:100})};
 });}
 safeWithdrawal(w:ChefWithdrawal){return {id:w.id,chefId:w.chefId,userId:w.userId,amountFen:w.amountFen,status:w.status,createdAt:w.createdAt,updatedAt:w.updatedAt,reason:obj(w.metadata).reason??obj(w.metadata).failReason??null};}
 override async settle(user:User,id:string):Promise<any>{
  if(process.env.APP_MODE==='sandbox')return super.settle(user,id);this.role(user,'FINANCE');
  return this.transaction(async tx=>{
   const old=await tx.chefSettlement.findUnique({where:{orderId:id}});if(old)return old;
   const o=await tx.order.findUnique({where:{id}});ensure(o?.acceptedChefId,'NOT_FOUND','订单或厨师不存在',404);const d=obj(o.details);
   ensure(o.settlementStatus==='PENDING'&&o.feeStatus==='SETTLED'&&['NONE','CLOSED'].includes(o.aftersaleStatus)&&o.contractStatus==='FULFILLED'&&o.balanceFen===0&&o.confirmedAt,'SETTLEMENT_BLOCKED','订单未完成、费用未结清或存在争议');
   ensure(o.confirmedAt.getTime()+this.holdHours()*HOUR<this.clock().getTime(),'SETTLEMENT_HOLD','订单仍在售后保护期');
   ensure(!d.adjudicated&&!d.pendingChange,'ALLOCATION_PENDING','裁定或变更订单需要单独确认分配');
   ensure(!await tx.serviceTicket.findFirst({where:{orderId:id,status:{not:'CLOSED'}}}),'SETTLEMENT_BLOCKED','订单存在未完结售后');
   const payments=await tx.paymentRequest.findMany({where:{orderId:id}});ensure(!payments.some(p=>p.kind==='REFUND'&&p.status!=='SUCCEEDED'),'REFUND_PENDING','请等待退款确认完成');
   const captures=payments.filter(p=>p.kind!=='REFUND'&&p.provider==='wechat'&&p.status==='SUCCEEDED');const net=o.receivedFen-o.refundedFen;
   ensure(captures.reduce((s,p)=>s+p.amountFen,0)===o.receivedFen&&net>0,'FUNDS_MISMATCH','实收资金与微信账本不一致');
   const rate=obj(o.ruleSnapshot).commissionRate;ensure(Number.isFinite(rate)&&rate>=0&&rate<1&&Number.isSafeInteger(d.serviceFen),'INVALID_RATE','结算规则快照无效');
   const commissionFen=Math.round(d.serviceFen*rate),subsidyFen=d.discountFen??0,chefFen=net+subsidyFen-commissionFen;ensure(Number.isSafeInteger(chefFen)&&chefFen>=0&&Number.isSafeInteger(subsidyFen)&&subsidyFen>=0,'INVALID_ALLOCATION','结算金额异常');
   const mode=d.payoutMode??'TRANSFER';ensure(['TRANSFER','PROFITSHARING'].includes(mode),'FINANCE_CONFIG','结算方式无效');const chef=await tx.chef.findUniqueOrThrow({where:{id:o.acceptedChefId}});ensure(chef.userId!==user.id,'SELF_APPROVAL','不可结算本人订单');
   const recipient=await tx.user.findUniqueOrThrow({where:{id:chef.userId}});
   if(mode==='PROFITSHARING'){this.gateway();ensure(process.env.WECHAT_PROFITSHARING_ENABLED==='true'&&recipient.openId&&obj(chef.data).payoutName&&obj(chef.data).payoutConsentAt,'PROFITSHARING_CONFIG','请开通分账并由厨师绑定实名收款资料');ensure(subsidyFen===0,'SUBSIDY_UNSUPPORTED','含平台补贴的订单应使用余额提现模式');ensure(captures.every(p=>obj(p.rawEvent).profitSharing===true),'PROFITSHARING_CONFIG','该订单未按分账模式收款');}
   const settlement=await tx.chefSettlement.create({data:{orderId:id,chefId:chef.id,mode,status:mode==='TRANSFER'?'AVAILABLE':'PROCESSING',chefFen,commissionFen,subsidyFen,snapshot:{netFen:net,serviceFen:d.serviceFen,rate,approvedBy:user.id,paymentIds:captures.map(p=>p.id)}}});
   if(mode==='TRANSFER'){
    await tx.chefWalletEntry.create({data:{chefId:chef.id,reference:'settlement:'+id,kind:'ORDER_INCOME',amountFen:chefFen}});
    await tx.ledgerEntry.create({data:{orderId:id,reference:'chef-payable:'+id,kind:'CHEF_PAYABLE',amountFen:-chefFen}});
    if(subsidyFen)await tx.ledgerEntry.create({data:{orderId:id,reference:'subsidy:'+id,kind:'PLATFORM_SUBSIDY',amountFen:subsidyFen}});
   }else{
    const limit=Number(process.env.WECHAT_PROFITSHARING_MAX_RATIO);ensure(limit>0&&limit<=1,'PROFITSHARING_CONFIG','请配置商户已获批的最大分账比例');let remaining=chefFen;
    for(let i=0;i<captures.length;i++){const p=captures[i],refunded=payments.filter(r=>r.kind==='REFUND'&&r.status==='SUCCEEDED'&&obj(r.rawEvent).paymentId===p.id).reduce((s,r)=>s+r.amountFen,0),available=p.amountFen-refunded;const amount=i===captures.length-1?remaining:Math.floor(chefFen*available/net);remaining-=amount;
     ensure(amount<=Math.min(available,Math.floor(p.amountFen*limit)),'PROFITSHARING_LIMIT','厨师分账金额超过商户获批比例');
     await tx.profitShareTask.create({data:{settlementId:settlement.id,paymentId:p.id,orderId:id,chefId:chef.id,amountFen:amount,metadata:{transactionId:p.providerRef,openId:recipient.openId,encryptedName:obj(chef.data).payoutName,appId:this.gateway().config.appId,mchId:this.gateway().config.mchId}}});
    }
   }
   await tx.order.update({where:{id},data:{settlementStatus:mode==='TRANSFER'?'SETTLED':'PROCESSING',details:{...d,settlement:{chefFen,commissionFen,subsidyFen,mode,status:settlement.status}}}});
   await this.audit(tx,user.id,'CHEF_SETTLEMENT_CREATED',id,{chefFen,commissionFen,subsidyFen,mode});await this.event(tx,mode==='TRANSFER'?'订单收入已结算至厨师可提现余额':'订单已提交微信分账，等待到账',o,[chef.userId]);return settlement;
  });
 }
 async payoutProfile(user:User,b:any){return this.transaction(async tx=>{
  const chef=await tx.chef.findUnique({where:{userId:user.id}}),u=await tx.user.findUniqueOrThrow({where:{id:user.id}});ensure(chef&&['TRIAL','APPROVED'].includes(chef.status),'NOT_CHEF','审核通过后可绑定收款资料');ensure(u.openId,'WECHAT_LOGIN','请在小程序绑定微信');ensure(b.consent===true,'CONSENT_REQUIRED','请授权向微信校验收款身份');const name=text(b.name,'微信实名姓名',64);
  await tx.chef.update({where:{id:chef.id},data:{data:{...obj(chef.data),payoutName:encrypt(name),payoutConsentAt:this.clock().toISOString()}}});await this.audit(tx,user.id,'CHEF_PAYOUT_PROFILE',chef.id);return {configured:true};
 });}
 async withdraw(user:User,b:any){const c=this.transferConfig();return this.transaction(async tx=>{
  const key=user.id+':withdraw:'+text(b.idempotencyKey,'幂等键',100),amountFen=integer(b.amountFen,'提现金额',10,c.max),old=await tx.chefWithdrawal.findUnique({where:{idempotencyKey:key}});if(old){ensure(old.amountFen===amountFen,'IDEMPOTENCY_CONFLICT','请求金额不一致');return this.safeWithdrawal(old);}
  const chef=await tx.chef.findUnique({where:{userId:user.id}}),account=await tx.user.findUniqueOrThrow({where:{id:user.id}});ensure(chef&&['TRIAL','APPROVED'].includes(chef.status),'NOT_CHEF','当前厨师状态不允许提现');ensure(account.openId&&obj(chef.data).payoutName&&obj(chef.data).payoutConsentAt,'PAYOUT_PROFILE','请先绑定微信实名收款资料');
  ensure(!await tx.order.findFirst({where:{acceptedChefId:chef.id,aftersaleStatus:'PROCESSING'}}),'DISPUTED','存在处理中售后，暂缓提现');ensure(await this.walletBalance(tx,chef.id)>=amountFen,'INSUFFICIENT_BALANCE','可提现余额不足');
  const w=await tx.chefWithdrawal.create({data:{chefId:chef.id,userId:user.id,amountFen,idempotencyKey:key,encryptedName:obj(chef.data).payoutName,metadata:{openId:account.openId,appId:this.gateway().config.appId,mchId:this.gateway().config.mchId,scene:c.scene,reports:c.reports,notifyUrl:c.notifyUrl}}});
  await tx.chefWalletEntry.create({data:{chefId:chef.id,reference:'hold:'+w.id,kind:'WITHDRAWAL_HOLD',amountFen:-amountFen}});await this.audit(tx,user.id,'CHEF_WITHDRAWAL_REQUESTED',w.id,{amountFen});return this.safeWithdrawal(w);
 });}
 async withdrawalAction(user:User,id:string,b:any){return this.transaction(async tx=>{
  const w=await tx.chefWithdrawal.findUnique({where:{id}});ensure(w,'NOT_FOUND','提现单不存在',404);
  const own=w.userId===user.id;ensure(b.action==='cancel'||b.action==='approve'||b.action==='reject','INVALID_ACTION','操作无效');if(b.action==='cancel')ensure(own,'FORBIDDEN','只能取消本人提现',403);else{this.role(user,'FINANCE');ensure(!own,'SELF_APPROVAL','不可审核本人提现');}
  ensure(w.status==='REQUESTED','WITHDRAWAL_PROCESSING','转账已开始，不能本地取消或重复审批');
  if(b.action==='approve'){
   this.transferConfig();const chef=await tx.chef.findUniqueOrThrow({where:{id:w.chefId}});ensure(['APPROVED','TRIAL'].includes(chef.status)&&!await tx.order.findFirst({where:{acceptedChefId:w.chefId,aftersaleStatus:'PROCESSING'}}),'DISPUTED','厨师资质或售后状态不允许打款');
   await tx.chefWithdrawal.update({where:{id},data:{status:'APPROVED',approvedBy:user.id}});
  }else{await tx.chefWithdrawal.update({where:{id},data:{status:b.action==='cancel'?'CANCELLED':'REJECTED',metadata:{...obj(w.metadata),reason:text(b.reason??'申请人取消','原因',300)}}});await tx.chefWalletEntry.create({data:{chefId:w.chefId,reference:'release:'+id,kind:'WITHDRAWAL_RELEASE',amountFen:w.amountFen}});}
  await this.audit(tx,user.id,'WITHDRAWAL_'+b.action.toUpperCase(),id);return {ok:true};
 });} async recordTransfer(r:any){const wx=this.gateway();return this.transaction(async tx=>{
  const w=await tx.chefWithdrawal.findUnique({where:{id:r.out_bill_no}});ensure(w,'TRANSFER_NOT_FOUND','提现单不存在',400);const m=obj(w.metadata);
  ensure(r.mch_id===wx.config.mchId&&r.appid===wx.config.appId&&r.mch_id===m.mchId&&r.appid===m.appId&&r.openid===m.openId&&r.transfer_amount===w.amountFen&&typeof r.transfer_bill_no==='string','TRANSFER_MISMATCH','微信转账信息不一致',400);
  ensure(!m.transferBillNo||m.transferBillNo===r.transfer_bill_no,'TRANSFER_MISMATCH','转账单号不一致',400);
  if(['SUCCESS','FAIL','CANCELLED','REJECTED'].includes(w.status)){ensure(w.status===r.state,'TRANSFER_CONFLICT','终态转账信息冲突',400);return;}
  ensure(w.approvedBy&&w.status!=='REQUESTED','TRANSFER_UNAPPROVED','提现尚未审批',400);ensure(['ACCEPTED','PROCESSING','WAIT_USER_CONFIRM','TRANSFERING','CANCELING','SUCCESS','FAIL','CANCELLED'].includes(r.state),'TRANSFER_STATE','未知转账状态',400);
  await tx.chefWithdrawal.update({where:{id:w.id},data:{status:r.state,metadata:{...m,transferBillNo:r.transfer_bill_no,packageInfo:r.package_info??m.packageInfo??null,failReason:r.fail_reason??null}}});
  if(['FAIL','CANCELLED'].includes(r.state))await tx.chefWalletEntry.create({data:{chefId:w.chefId,reference:'release:'+w.id,kind:'WITHDRAWAL_RELEASE',amountFen:w.amountFen}});
  if(['SUCCESS','FAIL','CANCELLED'].includes(r.state)){await this.audit(tx,null,'WECHAT_TRANSFER_'+r.state,w.id,{amountFen:w.amountFen});await tx.notification.create({data:{userId:w.userId,body:r.state==='SUCCESS'?'微信提现已到账':'微信提现未完成，冻结金额已退回可提现余额'}});}
 });}
 async transferNotification(h:Record<string,any>,raw:string){const event=this.gateway().notification(h,raw,'MCHTRANSFER.BILL.FINISHED','mch_payment');await this.recordTransfer(event);log('info','transfer.callback.accepted',{jobId:event.out_bill_no});}
 async syncTransfer(id:string){
  let w=await this.db.chefWithdrawal.findUniqueOrThrow({where:{id}});if(!ACTIVE.includes(w.status)||w.status==='REQUESTED')return;const wx=this.gateway();
  if(this.clock().getTime()-w.createdAt.getTime()>29*24*HOUR){await this.transaction(async tx=>{const fresh=await tx.chefWithdrawal.findUniqueOrThrow({where:{id}});if(ACTIVE.includes(fresh.status)&&fresh.status!=='REQUESTED')await tx.chefWithdrawal.update({where:{id},data:{status:'REVIEW_REQUIRED',metadata:{...obj(fresh.metadata),reason:'超过自动查单期限，请财务核对微信资金账单；余额继续冻结'}}});});return;}
  if(w.status==='APPROVED')w=await this.transaction(async tx=>{
   const current=await tx.chefWithdrawal.findUniqueOrThrow({where:{id}});if(current.status!=='APPROVED')return current;
   ensure(!await tx.order.findFirst({where:{acceptedChefId:w.chefId,aftersaleStatus:'PROCESSING'}}),'DISPUTED','处理中售后阻止打款');const chef=await tx.chef.findUniqueOrThrow({where:{id:w.chefId}});ensure(['APPROVED','TRIAL'].includes(chef.status),'NOT_CHEF','厨师状态不允许打款');
   return tx.chefWithdrawal.update({where:{id},data:{status:'PROCESSING'}});
  });
  const path='/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/'+id;let result:any;
  try{result=await wx.request('GET',path);}catch(e){
   if(!(e instanceof ApiError)||e.code!=='WECHAT_NOT_FOUND')throw e;
   this.transferConfig();const dispatch=await this.transaction(async tx=>{const fresh=await tx.chefWithdrawal.findUniqueOrThrow({where:{id}});if(!ACTIVE.includes(fresh.status)||fresh.status==='REQUESTED')return null;ensure(fresh.approvedBy,'TRANSFER_UNAPPROVED','提现尚未审批');const chef=await tx.chef.findUniqueOrThrow({where:{id:fresh.chefId}});ensure(['APPROVED','TRIAL'].includes(chef.status),'NOT_CHEF','厨师状态不允许打款');ensure(!await tx.order.findFirst({where:{acceptedChefId:fresh.chefId,aftersaleStatus:'PROCESSING'}}),'DISPUTED','处理中售后阻止打款');return fresh;});if(!dispatch)return;w=dispatch;const m=obj(w.metadata);ensure(m.appId===wx.config.appId&&m.mchId===wx.config.mchId,'TRANSFER_CONFIG','提现商户配置已变更');
   const r=await wx.request('POST','/v3/fund-app/mch-transfer/transfer-bills',{appid:m.appId,out_bill_no:id,transfer_scene_id:m.scene,openid:m.openId,user_name:wx.encryptName(decrypt(w.encryptedName)),transfer_amount:w.amountFen,transfer_remark:'厨师服务收入提现',notify_url:m.notifyUrl,transfer_scene_report_infos:m.reports});
   ensure(r.out_bill_no===id&&typeof r.transfer_bill_no==='string','TRANSFER_MISMATCH','转账应答单号不一致',502);
   await this.transaction(async tx=>{const fresh=await tx.chefWithdrawal.findUniqueOrThrow({where:{id}});if(ACTIVE.includes(fresh.status))await tx.chefWithdrawal.update({where:{id},data:{metadata:{...obj(fresh.metadata),transferBillNo:r.transfer_bill_no,packageInfo:r.package_info??null},...(r.state==='WAIT_USER_CONFIRM'&&['APPROVED','PROCESSING','ACCEPTED'].includes(fresh.status)?{status:'WAIT_USER_CONFIRM'}:{})}});});
   result=await wx.request('GET',path);
  }
  await this.recordTransfer(result);
 }
 async withdrawalStatus(user:User,id:string){let w=await this.db.chefWithdrawal.findUnique({where:{id}});ensure(w?.userId===user.id,'NOT_FOUND','提现单不存在',404);await this.syncTransfer(id);w=await this.db.chefWithdrawal.findUniqueOrThrow({where:{id}});const m=obj(w.metadata);return {...this.safeWithdrawal(w),...(w.status==='WAIT_USER_CONFIRM'&&m.packageInfo?{confirmation:{mchId:m.mchId,appId:m.appId,package:m.packageInfo}}:{})};}
 async syncShare(id:string){
  let task=await this.db.profitShareTask.findUniqueOrThrow({where:{id}});if(['SUCCEEDED','CANCELLED'].includes(task.status))return;const wx=this.gateway();
  if(task.status==='CREATED')task=await this.transaction(async tx=>{
   const fresh=await tx.profitShareTask.findUniqueOrThrow({where:{id}});if(fresh.status!=='CREATED')return fresh;const o=await tx.order.findUniqueOrThrow({where:{id:task.orderId}});ensure(o.settlementStatus==='PROCESSING'&&['NONE','CLOSED'].includes(o.aftersaleStatus),'DISPUTED','争议期间暂停分账');return tx.profitShareTask.update({where:{id},data:{status:'PROCESSING'}});
  });
  const m=obj(task.metadata);ensure(m.mchId===wx.config.mchId&&m.appId===wx.config.appId,'SHARE_CONFIG','分账商户配置不一致');
  const path='/v3/profitsharing/orders/'+id+'?transaction_id='+encodeURIComponent(m.transactionId);let result:any;
  try{result=await wx.request('GET',path);}catch(e){
   if(!(e instanceof ApiError)||e.code!=='WECHAT_RESOURCE_NOT_EXISTS')throw e;
   const canDispatch=async()=>this.transaction(async tx=>{const fresh=await tx.profitShareTask.findUniqueOrThrow({where:{id}});if(['SUCCEEDED','CANCELLED'].includes(fresh.status))return false;ensure(fresh.status!=='FAILED','SHARE_CLOSED','已失败的分账需财务核查，不自动换单重发');const o=await tx.order.findUniqueOrThrow({where:{id:fresh.orderId}});ensure(o.settlementStatus==='PROCESSING'&&['NONE','CLOSED'].includes(o.aftersaleStatus),'DISPUTED','争议期间暂停分账');return true;});if(!await canDispatch())return;
   if(task.amountFen>0){const name=wx.encryptName(decrypt(m.encryptedName));const receiver=await wx.request('POST','/v3/profitsharing/receivers/add',{appid:m.appId,type:'PERSONAL_OPENID',account:m.openId,name,relation_type:'PARTNER'});ensure(receiver.type==='PERSONAL_OPENID'&&receiver.account===m.openId,'SHARE_RECEIVER','分账接收方不匹配');
    if(!await canDispatch())return;result=await wx.request('POST','/v3/profitsharing/orders',{appid:m.appId,transaction_id:m.transactionId,out_order_no:id,receivers:[{type:'PERSONAL_OPENID',account:m.openId,name,amount:task.amountFen,description:'厨师上门服务收入'}],unfreeze_unsplit:true});
   }else result=await wx.request('POST','/v3/profitsharing/orders/unfreeze',{transaction_id:m.transactionId,out_order_no:id,description:'平台服务佣金解冻'});
  }
  ensure(result.out_order_no===id&&result.transaction_id===m.transactionId,'SHARE_MISMATCH','微信分账单号不一致',502);
  const receiver=task.amountFen>0?result.receivers?.find((r:any)=>r.type==='PERSONAL_OPENID'&&r.account===m.openId):null;
  if(task.amountFen>0)ensure(receiver&&receiver.amount===task.amountFen,'SHARE_MISMATCH','分账接收金额不一致',502);
  const complete=result.state==='FINISHED',success=complete&&(task.amountFen===0||receiver.result==='SUCCESS'),failed=complete&&!success;
  await this.transaction(async tx=>{
   const fresh=await tx.profitShareTask.findUniqueOrThrow({where:{id}});if(['SUCCEEDED','CANCELLED','FAILED'].includes(fresh.status))return;
   await tx.profitShareTask.update({where:{id},data:{status:success?'SUCCEEDED':failed?'FAILED':'PROCESSING',metadata:{...obj(fresh.metadata),providerRef:result.order_id??null,failReason:receiver?.fail_reason??null}}});
   if(success&&task.amountFen>0)await tx.ledgerEntry.create({data:{orderId:task.orderId,reference:'profitshare:'+id,kind:'WECHAT_PROFITSHARE',amountFen:-task.amountFen}});
   if(task.settlementId){const all=await tx.profitShareTask.findMany({where:{settlementId:task.settlementId}}),status=all.every(t=>t.status==='SUCCEEDED')?'PAID':all.some(t=>t.status==='FAILED')?'ATTENTION':'PROCESSING';
    await tx.chefSettlement.update({where:{id:task.settlementId},data:{status}});
    const order=await tx.order.findUniqueOrThrow({where:{id:task.orderId}});await tx.order.update({where:{id:task.orderId},data:{details:{...obj(order.details),settlement:{...obj(obj(order.details).settlement),status}},...(status==='PAID'?{settlementStatus:'SETTLED'}:{})}});if(status==='PAID')await this.audit(tx,null,'WECHAT_PROFITSHARING_PAID',task.orderId);
   }
  });
 }
 override async queueRefund(tx:Tx,o:Order,amount:number,key:string,onlyPayment?:string){
  const s=await tx.chefSettlement.findUnique({where:{orderId:o.id}});
  if(s&&s.status!=='REVERSED'&&(!onlyPayment||obj(s.snapshot).paymentIds?.includes(onlyPayment)))ensure(false,'RECOVERY_REQUIRED','该订单已进入结算，请财务核对厨师出款并完成追偿后处理退款');
  return super.queueRefund(tx,o,amount,key,onlyPayment);
 }
 async financeRoles(user:User,b?:any){this.role(user,'ADMIN');if(!b)return this.db.user.findMany({where:{roles:{hasSome:['FINANCE','FINANCE_MANAGER']}},select:{id:true,username:true,displayName:true,roles:true}});
  ensure(['FINANCE','FINANCE_MANAGER'].includes(b.role)&&typeof b.enabled==='boolean','INVALID_ROLE','财务权限参数无效',400);return this.transaction(async tx=>{const target=await tx.user.findUnique({where:{username:text(b.username,'账号',40)}});ensure(target&&target.id!==user.id,'INVALID_ACCOUNT','请选择其他已注册账号，不能修改本人权限');const roles=b.enabled?[...new Set([...target.roles,b.role])]:target.roles.filter(r=>r!==b.role);await tx.user.update({where:{id:target.id},data:{roles}});await this.audit(tx,user.id,'FINANCE_ROLE_CHANGED',target.id,{role:b.role,enabled:b.enabled,reason:text(b.reason,'授权原因',300)});return {ok:true};});
 }
 async financeOverview(user:User){this.role(user,'FINANCE','FINANCE_MANAGER');const orders=await this.db.order.findMany({where:{settlementStatus:{in:['PENDING','PROCESSING','FROZEN']}},orderBy:{createdAt:'desc'},take:100});return {holdHours:this.holdHours(),orders:orders.map(o=>({id:o.id,chefId:o.acceptedChefId,status:o.settlementStatus,receivedFen:o.receivedFen,refundedFen:o.refundedFen,eligibleAt:o.confirmedAt?new Date(o.confirmedAt.getTime()+this.holdHours()*HOUR):null})),settlements:await this.db.chefSettlement.findMany({orderBy:{createdAt:'desc'},take:100}),withdrawals:(await this.db.chefWithdrawal.findMany({orderBy:{createdAt:'desc'},take:100})).map(w=>this.safeWithdrawal(w)),shares:await this.db.profitShareTask.findMany({select:{id:true,orderId:true,amountFen:true,status:true,updatedAt:true},orderBy:{updatedAt:'desc'},take:100})};}
 async reconcileFinance(user:User,kind:string,id:string){this.role(user,'FINANCE','FINANCE_MANAGER');if(kind==='withdrawals')await this.syncTransfer(id);else if(kind==='shares')await this.syncShare(id);else ensure(false,'INVALID_ACTION','无效财务操作');return {ok:true};}
 private financeRunning=false;
 override async tick(){
  const result=await super.tick();if(!this.wx||this.financeRunning)return result;this.financeRunning=true;
  try{const withdrawals=await this.db.chefWithdrawal.findMany({where:{status:{in:ACTIVE.filter(s=>s!=='REQUESTED')}},orderBy:{updatedAt:'asc'},take:3});const shares=await this.db.profitShareTask.findMany({where:{status:{in:['CREATED','PROCESSING']}},orderBy:{updatedAt:'asc'},take:3});
   await Promise.all([...withdrawals.map(w=>({kind:'withdrawal',id:w.id})),...shares.map(s=>({kind:'share',id:s.id}))].map(async job=>{try{if(job.kind==='withdrawal')await this.syncTransfer(job.id);else await this.syncShare(job.id);}catch(e){log('warn','finance.reconcile_pending',{jobId:job.id,kind:job.kind,...safeError(e)});}finally{if(job.kind==='withdrawal')await this.db.chefWithdrawal.update({where:{id:job.id},data:{updatedAt:this.clock()}});else await this.db.profitShareTask.update({where:{id:job.id},data:{updatedAt:this.clock()}});}}));
  }finally{this.financeRunning=false;}return result;
 }
}