import { Prisma, User, Order } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Service, obj, HOUR } from './service';
import { ensure, text, integer } from './errors';
import { decrypt, digest } from './security';
import { commissionFen, imRisk, remainingChefFen, srsInput } from './policy';
type Data=Record<string,any>;
type Tx=Prisma.TransactionClient;
export class MvpService extends Service {


  async cancelQuote(user:User,id:string){
    return this.transaction(async tx=>{
      const q=await tx.quote.findUnique({where:{id}});ensure(q?.customerId===user.id,'NOT_FOUND','报价不存在',404);
      ensure(!['PAID','SUBMITTED'].includes(q.status),'QUOTE_PAID','已支付报价不能撤回');
      await tx.bookingLock.deleteMany({where:{quoteId:id,orderId:null}});
      await tx.quote.update({where:{id},data:{status:'CANCELLED'}});
      await this.audit(tx,user.id,'QUOTE_CANCELLED',id);return {ok:true};
    });
  }

  async change(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id),d=obj(o.details),c=await tx.chef.findUnique({where:{userId:user.id}});
      const customer=o.customerId===user.id,chef=c?.id===o.acceptedChefId;
      ensure(customer||chef,'FORBIDDEN','仅交易双方可以协商变更',403);
      ensure(o.contractStatus==='ACCEPTED'&&['READY','DEPARTED','ARRIVED','SERVING'].includes(o.fulfillmentStatus)&&o.aftersaleStatus==='NONE','CHANGE_BLOCKED','当前状态不可改约或改价');
      const pending=d.pendingChange;
      if(b.action==='propose'){
        ensure(!pending,'CHANGE_PENDING','请先处理当前变更');
        ensure(['SCHEDULE','BUDGET','MENU'].includes(b.kind),'INVALID_CHANGE','变更类型无效',400);
        const proposal:Data={id:randomUUID(),kind:b.kind,createdBy:user.id,reason:text(b.reason,'变更说明',500),createdAt:this.clock().toISOString()};
        if(b.kind==='SCHEDULE'){
          ensure(o.fulfillmentStatus==='READY','CHANGE_TOO_LATE','已出发后请走客服改约');
          const startsAt=new Date(text(b.startsAt,'新时间')),duration=new Date(d.endsAt).getTime()-new Date(d.startsAt).getTime(),advance=startsAt.getTime()-this.clock().getTime();
          ensure(Number.isFinite(advance)&&advance>=24*HOUR&&advance<=30*24*HOUR&&startsAt.getMinutes()%30===0&&startsAt.getSeconds()===0,'BOOKING_WINDOW','改约须提前24小时至30天，按半小时选择');
          proposal.startsAt=startsAt.toISOString();proposal.endsAt=new Date(startsAt.getTime()+duration).toISOString();
          ensure(await this.available(tx,o.acceptedChefId!,{...d,...proposal},o.quoteId),'SCHEDULE_CONFLICT','新档期不可用，原档期保持');
        }else if(b.kind==='BUDGET'){
          ensure(chef&&d.ingredientMode==='CHEF','INVALID_BUDGET','仅本单厨师可提交采购增量');
          proposal.ingredientFen=integer(b.ingredientFen,'新采购预算',d.ingredientFen+1,100000);
          proposal.additionalFen=proposal.ingredientFen-d.ingredientFen;
        }else proposal.menu=text(b.menu,'变更菜单',1000);
        const updated=await tx.order.update({where:{id},data:{details:{...d,pendingChange:proposal}}});
        await this.audit(tx,user.id,'CHANGE_PROPOSED',id,{proposal});await this.event(tx,'有待确认的改约或费用变更',updated);return this.viewOrder(tx,user,updated);
      }
      ensure(pending&&pending.id===b.changeId,'CHANGE_NOT_FOUND','变更不存在或已处理');
      ensure(pending.createdBy!==user.id,'COUNTERPART_REQUIRED','变更须由另一方确认');
      ensure(b.action==='accept'||b.action==='reject','INVALID_ACTION','请选择同意或拒绝',400);
      let data:Data={details:{...d,pendingChange:null}};
      if(b.action==='accept'){
        if(pending.kind==='SCHEDULE'){
          ensure(await this.available(tx,o.acceptedChefId!,{...d,...pending},o.quoteId),'SCHEDULE_CONFLICT','新档期已不可用，原档期保持');
          await tx.bookingLock.update({where:{orderId:id},data:{startsAt:new Date(new Date(pending.startsAt).getTime()-HOUR),endsAt:new Date(new Date(pending.endsAt).getTime()+HOUR)}});
          data.details={...data.details,startsAt:pending.startsAt,endsAt:pending.endsAt,earlyAddressConsent:false};
        }else if(pending.kind==='BUDGET'){
          ensure(customer,'FORBIDDEN','采购增量须用户确认支付',403);
          ensure(process.env.APP_MODE==='sandbox','WECHAT_PAYMENT_REQUIRED','请在微信小程序确认并支付采购补款，到账后预算才会生效');
          await this.payment(tx,o,pending.additionalFen,'ADDITIONAL','change:'+pending.id);
          data={...data,totalFen:o.totalFen+pending.additionalFen,receivedFen:o.receivedFen+pending.additionalFen,details:{...data.details,ingredientFen:pending.ingredientFen}};
        }else data.details={...data.details,menu:pending.menu};
      }
      const updated=await tx.order.update({where:{id},data});
      await this.audit(tx,user.id,'CHANGE_'+b.action.toUpperCase(),id,{proposal:pending});await this.event(tx,'变更已'+(b.action==='accept'?'确认':'拒绝'),updated);return this.viewOrder(tx,user,updated);
    });
  }

  async favorites(user:User,id?:string) {
    if(!id)return this.db.favorite.findMany({where:{userId:user.id}});
    return this.transaction(async tx=>{ensure(await tx.chef.findUnique({where:{id}}),'NOT_FOUND','厨师不存在',404);const old=await tx.favorite.findUnique({where:{userId_chefId:{userId:user.id,chefId:id}}});if(old)await tx.favorite.delete({where:{id:old.id}});else await tx.favorite.create({data:{userId:user.id,chefId:id}});return {favorite:!old};});
  }
  async coupons(user:User,claim=false) {
    if(claim) return this.transaction(async tx=>{
      const rules=await this.rules(tx);ensure(rules.couponEnabled,'COUPON_DISABLED','活动尚未开放');
      return tx.coupon.upsert({where:{id:'new-user:'+user.id},update:{},create:{id:'new-user:'+user.id,userId:user.id,label:'新人家宴券',amountFen:rules.couponFen,minFen:rules.couponMinFen,regionCode:rules.regions.find((r:Data)=>r.active).code,expiresAt:new Date(this.clock().getTime()+30*24*HOUR),ruleVersion:rules.id}});
    });
    return this.db.coupon.findMany({where:{userId:user.id},orderBy:{expiresAt:'desc'}});
  }
  async messages(user:User,id:string,b?:Data) {
    const result=await this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id),c=await tx.chef.findUnique({where:{userId:user.id}});
      const participant=o.customerId===user.id||c?.id===o.acceptedChefId;
      if(b){
        ensure(participant&&o.contractStatus==='ACCEPTED','CHAT_UNAVAILABLE','接单后交易双方可以聊天',403);
        const original=text(b.body,'消息',1000),risk=imRisk(original),blocked=risk.action==='BLOCK',body=risk.body;
        const row=await tx.chatMessage.create({data:{orderId:id,senderId:user.id,body,blocked}});
        await this.audit(tx,user.id,blocked?'IM_BLOCKED':risk.action==='MASK'?'IM_MASKED':'IM_SENT',id,{messageId:row.id,rule:risk.rule});
        if(blocked)return {blocked:true};
        await this.event(tx,'有新的订单消息',o,c?[c.userId]:[]);return row;
      }
      ensure(participant||user.roles.some(r=>['RISK','CUSTOMER_SERVICE'].includes(r)),'FORBIDDEN','无权查看聊天',403);
      if(!participant){ensure(await tx.serviceTicket.findFirst({where:{orderId:id,status:{not:'CLOSED'}}}),'TICKET_REQUIRED','调阅聊天需要关联开放工单',403);await this.audit(tx,user.id,'CHAT_STAFF_READ',id);}
      return tx.chatMessage.findMany({where:{orderId:id,...(participant?{OR:[{blocked:false},{senderId:user.id}]}:{})},orderBy:{createdAt:'asc'},take:200});
    });
    ensure(!('blocked' in result && result.blocked===true),'SENSITIVE_MESSAGE','消息包含联系方式或线下交易信息，已拦截并留痕',400);return result;
  }
  async upload(user:User,b:Data) {
    const mime=text(b.mime,'文件类型',50);ensure(['image/png','image/jpeg'].includes(mime),'INVALID_FILE','仅支持 PNG/JPEG 图片',400);
    const encoded=text(b.base64,'图片内容',4300000);ensure(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded),'INVALID_FILE','图片编码无效',400);
    const bytes=Buffer.from(encoded,'base64');ensure(bytes.length>8&&bytes.length<=3*1024*1024,'FILE_SIZE','图片不能超过3MB',400);
    ensure(mime==='image/png'?bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'INVALID_FILE','文件内容与图片类型不符',400);
    return this.transaction(async tx=>{
      if(b.orderId){const o=await this.authorizedOrder(tx,user,text(b.orderId,'订单'));const c=await tx.chef.findUnique({where:{userId:user.id}});ensure(o.customerId===user.id||o.acceptedChefId===c?.id,'FORBIDDEN','仅本单双方可以上传凭证',403);}
      const file=await tx.fileAsset.create({data:{userId:user.id,orderId:b.orderId??null,mime,bytes,sha256:digest(encoded)}});
      await this.audit(tx,user.id,'FILE_UPLOADED',file.id,{orderId:b.orderId??null});return {id:file.id,mime:file.mime};
    });
  }
  async file(user:User,id:string){
    return this.transaction(async tx=>{
      const f=await tx.fileAsset.findUnique({where:{id}});ensure(f,'NOT_FOUND','文件不存在',404);
      if(f.userId!==user.id){
        if(f.orderId){const o=await this.authorizedOrder(tx,user,f.orderId),c=await tx.chef.findUnique({where:{userId:user.id}});ensure(o.customerId===user.id||c?.id===o.acceptedChefId||user.roles.includes('CUSTOMER_SERVICE'),'FORBIDDEN','无权查看凭证',403);}
        else {this.role(user,'REVIEWER');ensure(await tx.chef.findFirst({where:{userId:f.userId}}),'FORBIDDEN','无审核材料关联',403);}
      }
      await this.audit(tx,user.id,'FILE_READ',id);return f;
    });
  }
  async ticket(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id),c=await tx.chef.findUnique({where:{userId:user.id}});
      ensure(o.customerId===user.id||c?.id===o.acceptedChefId,'FORBIDDEN','仅交易双方可以申请售后',403);
      const reason=text(b.reason,'售后原因',1000),incident=b.incident===true;
      ensure(incident||!o.confirmedAt||this.clock().getTime()-o.confirmedAt.getTime()<=7*24*HOUR,'AFTERSALE_EXPIRED','普通售后窗口已结束；安全事故请使用事故报案');
      ensure(!await tx.serviceTicket.findFirst({where:{orderId:id,status:{not:'CLOSED'}}}),'TICKET_EXISTS','已有处理中工单');
      const ticket=await tx.serviceTicket.create({data:{orderId:id,userId:user.id,reason:(incident?'【事故】':'')+reason}});
      await tx.order.update({where:{id},data:{aftersaleStatus:'PROCESSING',feeStatus:'DISPUTED',settlementStatus:o.settlementStatus==='SETTLED'?'SETTLED':'FROZEN'}});
      await this.audit(tx,user.id,'AFTERSALE_OPENED',id,{ticketId:ticket.id});return ticket;
    });
  }
  async review(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const o=await this.authorizedOrder(tx,user,id);ensure(o.customerId===user.id&&o.confirmedAt&&o.acceptedChefId,'FORBIDDEN','完成确认后用户可评价',403);
      const age=this.clock().getTime()-o.confirmedAt.getTime(),old=await tx.review.findUnique({where:{orderId:id}});
      if(b.followup){ensure(old&&age<=15*24*HOUR&&!old.followup,'REVIEW_WINDOW','不能重复追评或超过15天');return tx.review.update({where:{orderId:id},data:{followup:text(b.followup,'追评',500)}});}
      ensure(!old&&age<=7*24*HOUR,'REVIEW_WINDOW','不能重复初评或超过7天');
      const row=await tx.review.create({data:{orderId:id,userId:user.id,chefId:o.acceptedChefId,taste:integer(b.taste,'口味',1,5),service:integer(b.service,'服务',1,5),punctuality:integer(b.punctuality,'准时度',1,5),body:text(b.body,'评价',500),anonymous:b.anonymous===true}});
      await tx.order.update({where:{id},data:{reviewStatus:'REVIEWED'}});await this.audit(tx,user.id,'REVIEW_CREATED',id);return row;
    });
  }
  async insurance(user:User,id:string,b:Data){
    ensure(process.env.APP_MODE==='sandbox','INSURANCE_UNAVAILABLE','保险服务尚未开通',503);
    return this.transaction(async tx=>{const o=await this.authorizedOrder(tx,user,id);ensure(o.customerId===user.id,'FORBIDDEN','仅订单用户可报案',403);const policy=await tx.insurancePolicy.update({where:{orderId:id},data:{claimReason:text(b.reason,'报案内容',1000)}});await this.audit(tx,user.id,'SANDBOX_INSURANCE_CLAIM',id);return policy;});
  }
  async dashboard(user:User){
    this.role(user,'OPERATOR','ADMIN','FINANCE','FINANCE_MANAGER','CUSTOMER_SERVICE','REVIEWER','RISK');
    const since=new Date(this.clock().getTime()-30*24*HOUR);
    const [orders,chefs,users,newUsers,tickets,cancelled,disputes,payments,refunds]=await Promise.all([this.db.order.count(),this.db.chef.count(),this.db.user.count({where:{roles:{has:'USER'}}}),this.db.user.count({where:{createdAt:{gte:since},roles:{has:'USER'}}}),this.db.serviceTicket.count({where:{status:{not:'CLOSED'}}}),this.db.order.count({where:{contractStatus:'CANCELLED'}}),this.db.order.count({where:{aftersaleStatus:'PROCESSING'}}),this.db.ledgerEntry.aggregate({where:{kind:'PAYMENT'},_sum:{amountFen:true}}),this.db.ledgerEntry.aggregate({where:{kind:'REFUND'},_sum:{amountFen:true}})]);
    return {orders,chefs,users,newUsers30d:newUsers,openTickets:tickets,cancelledOrders:cancelled,disputedOrders:disputes,cancellationRate:orders?cancelled/orders:0,disputeRate:orders?disputes/orders:0,receivedFen:payments._sum.amountFen??0,refundedFen:-(refunds._sum.amountFen??0),sandbox:process.env.APP_MODE==='sandbox'};
  }
  async opsChefs(user:User){this.role(user,'REVIEWER','OPERATOR','ADMIN');const rows=await this.db.chef.findMany({include:{user:{select:{displayName:true}},packages:true},orderBy:{createdAt:'desc'}});const penalties=await this.db.chefPenalty.findMany({orderBy:{createdAt:'desc'}});return rows.map(c=>({...c,penalties:penalties.filter(p=>p.chefId===c.id),data:{...obj(c.data),payoutName:undefined,payoutBank:undefined,payoutAccount:undefined,...(user.roles.includes('REVIEWER')?{}:{healthAssetId:undefined,insuranceAssetId:undefined,pendingCerts:Object.fromEntries(Object.entries(obj(obj(c.data).pendingCerts)).map(([k,v])=>[k,{...obj(v),assetId:undefined}]))})}}));}
  async manageChef(user:User,id:string,b:Data){
    this.role(user,'REVIEWER','OPERATOR','ADMIN');
    return this.transaction(async tx=>{
      const chef=await tx.chef.findUnique({where:{id}});ensure(chef,'NOT_FOUND','厨师不存在',404);
      ensure(['SUSPENDED','BANNED','RESTORE'].includes(b.action),'INVALID_ACTION','厨师管理操作无效',400);
      const reason=text(b.reason,'处理原因',500);
      if(b.action==='RESTORE')ensure(chef.healthValidUntil&&chef.healthValidUntil>this.clock(),'EXPIRED_HEALTH','健康证已过期，不能恢复接单');
      const status=b.action==='RESTORE'?'APPROVED':b.action,acceptingOrders=b.action==='RESTORE';
      const row=await tx.chef.update({where:{id},data:{status,acceptingOrders}});
      await tx.chefPenalty.create({data:{chefId:id,kind:b.action,reason,createdBy:user.id,...(b.action==='SUSPENDED'&&b.days?{endsAt:new Date(this.clock().getTime()+integer(b.days,'限制天数',1,365)*24*HOUR)}:{})}});
      await tx.notification.create({data:{userId:chef.userId,body:b.action==='RESTORE'?'接单权限已恢复':b.action==='BANNED'?'账号已封禁：'+reason:'接单权限已暂停：'+reason}});
      await this.audit(tx,user.id,'CHEF_'+b.action,id,{reason});return row;
    });
  }
  async opsUsers(user:User){
    this.role(user,'CUSTOMER_SERVICE','RISK','ADMIN');
    const rows=await this.db.user.findMany({where:{roles:{has:'USER'}},select:{id:true,displayName:true,status:true,phoneVerifiedAt:true,createdAt:true,updatedAt:true,_count:{select:{customerOrders:true,addresses:true}}},orderBy:{createdAt:'desc'},take:500});
    return rows.map(row=>({...row,phone:row.phoneVerifiedAt?'已绑定（默认脱敏）':'未绑定'}));
  }
  async manageUser(user:User,id:string,b:Data){
    this.role(user,'RISK','ADMIN');ensure(user.id!==id,'SELF_ACTION','不能冻结本人',400);
    return this.transaction(async tx=>{const target=await tx.user.findUnique({where:{id}});ensure(target,'NOT_FOUND','用户不存在',404);ensure(['freeze','restore'].includes(b.action),'INVALID_ACTION','用户操作无效',400);const status=b.action==='freeze'?'FROZEN':'ACTIVE';await tx.user.update({where:{id},data:{status}});if(status==='FROZEN')await tx.appSession.deleteMany({where:{userId:id}});await this.audit(tx,user.id,'USER_'+status,id,{reason:text(b.reason,'处理原因',500)});return {ok:true};});
  }
  async revealUserPhone(user:User,id:string){
    this.role(user,'CUSTOMER_SERVICE','RISK','ADMIN');
    return this.transaction(async tx=>{const target=await tx.user.findUnique({where:{id}});ensure(target?.phoneEncrypted,'PHONE_UNAVAILABLE','用户未绑定手机号',404);await this.audit(tx,user.id,'USER_PHONE_READ',id);return {phone:decrypt(target.phoneEncrypted)};});
  }
  async agreements(kind?:string){
    const rows=await this.db.agreementVersion.findMany({where:{active:true,...(kind?{kind}:{})},orderBy:[{kind:'asc'},{version:'desc'}]});
    return rows.filter((row,index)=>rows.findIndex(v=>v.kind===row.kind)===index).map(({publishedBy,...row})=>row);
  }
  async publishAgreement(user:User,b:Data){
    this.role(user,'ADMIN');const kind=text(b.kind,'协议类型',40);ensure(['USER_SERVICE','PRIVACY','CHEF_SERVICE','REFUND_DISPUTE'].includes(kind),'INVALID_AGREEMENT','协议类型无效',400);
    return this.transaction(async tx=>{const latest=await tx.agreementVersion.findFirst({where:{kind},orderBy:{version:'desc'}});await tx.agreementVersion.updateMany({where:{kind,active:true},data:{active:false}});const row=await tx.agreementVersion.create({data:{kind,title:text(b.title,'协议标题',100),content:text(b.content,'协议内容',50000),version:(latest?.version??0)+1,publishedBy:user.id}});await this.audit(tx,user.id,'AGREEMENT_PUBLISHED',row.id,{kind,version:row.version});return row;});
  }
  async opsChats(user:User,query:Data){
    this.role(user,'CUSTOMER_SERVICE','RISK','ADMIN');
    const userId=String(query.userId??''),chefId=String(query.chefId??'');ensure(userId||chefId,'SEARCH_REQUIRED','请输入用户 ID 或厨师 ID',400);
    const orders=await this.db.order.findMany({where:{...(userId?{customerId:userId}:{}),...(chefId?{acceptedChefId:chefId}:{})},orderBy:{createdAt:'desc'},take:50});
    const allowed=[] as Data[];
    for(const order of orders){if(!await this.db.serviceTicket.findFirst({where:{orderId:order.id,status:{not:'CLOSED'}}}))continue;await this.db.$transaction(tx=>this.audit(tx,user.id,'CHAT_STAFF_READ',order.id));allowed.push({orderId:order.id,customerId:order.customerId,chefId:order.acceptedChefId,messages:await this.db.chatMessage.findMany({where:{orderId:order.id},orderBy:{createdAt:'asc'},take:200})});}
    return allowed;
  }
  /** SRS 3.3.6: chef submits a renewed health certificate or accident insurance policy for review. */
  async submitCertificate(user:User,b:Data){
    ensure(['HEALTH','INSURANCE'].includes(b.kind),'INVALID_CERT','证照类型无效',400);
    const validUntil=new Date(text(b.validUntil,'有效期至'));ensure(Number.isFinite(validUntil.getTime())&&validUntil>this.clock(),'INVALID_CERT','有效期须晚于今天',400);
    return this.transaction(async tx=>{
      const c=await tx.chef.findUnique({where:{userId:user.id}});ensure(c&&!['CLOSED','BANNED'].includes(c.status),'NOT_CHEF','请先申请成为厨师',403);
      const file=await tx.fileAsset.findUnique({where:{id:text(b.assetId,'证照图片')}});ensure(file?.userId===user.id&&!file.orderId,'INVALID_EVIDENCE','请上传本人证照图片',400);
      const d=obj(c.data),pendingCerts={...obj(d.pendingCerts),[b.kind]:{assetId:file.id,validUntil:validUntil.toISOString(),submittedAt:this.clock().toISOString()}};
      await tx.chef.update({where:{id:c.id},data:{data:{...d,pendingCerts}}});
      await this.audit(tx,user.id,'CHEF_CERT_SUBMITTED',c.id,{kind:b.kind});return {kind:b.kind,status:'PENDING_REVIEW'};
    });
  }
  async reviewCertificate(user:User,id:string,b:Data){
    this.role(user,'REVIEWER');ensure(['HEALTH','INSURANCE'].includes(b.kind)&&['approve','reject'].includes(b.action),'INVALID_ACTION','证照审核参数无效',400);
    const reason=text(b.reason,'审核说明',500);
    return this.transaction(async tx=>{
      const c=await tx.chef.findUnique({where:{id}});ensure(c,'NOT_FOUND','厨师不存在',404);ensure(c.userId!==user.id,'SELF_REVIEW','不可审核本人');
      const d=obj(c.data),pending=obj(obj(d.pendingCerts)[b.kind]);ensure(pending.assetId,'NO_PENDING_CERT','没有待审核的证照');
      const {[b.kind]:_,...rest}=obj(d.pendingCerts);let data:Data={...d,pendingCerts:rest},update:Data={};
      if(b.action==='approve'){
        const until=new Date(pending.validUntil);ensure(until>this.clock(),'EXPIRED_CERT','证照已过期，请驳回');
        if(b.kind==='HEALTH'){
          data={...data,healthAssetId:pending.assetId};update={healthValidUntil:until};
          if(c.status==='SUSPENDED'&&d.suspendedReason==='HEALTH_EXPIRED'){const {suspendedReason,statusBeforeSuspend,...clean}=data;data=clean;update={...update,status:statusBeforeSuspend??'APPROVED',acceptingOrders:true};}
        }else{data={...data,insuranceAssetId:pending.assetId};update={insuranceValidUntil:until};}
      }
      const row=await tx.chef.update({where:{id},data:{...update,data}});
      await tx.notification.create({data:{userId:c.userId,body:(b.kind==='HEALTH'?'健康证':'意外险保单')+(b.action==='approve'?'审核通过':'未通过：'+reason)}});
      await this.audit(tx,user.id,'CHEF_CERT_'+b.action.toUpperCase(),id,{kind:b.kind,reason});return row;
    });
  }
  async auditChef(user:User,id:string,b:Data){
    this.role(user,'REVIEWER');
    return this.transaction(async tx=>{
      const c=await tx.chef.findUnique({where:{id}});ensure(c,'NOT_FOUND','厨师不存在',404);ensure(c.userId!==user.id,'SELF_REVIEW','不可审核本人');
      ensure(['TRIAL','APPROVED','REJECTED','SUSPENDED'].includes(b.status),'INVALID_STATUS','审核状态无效',400);
      if(['TRIAL','APPROVED'].includes(b.status)){ensure(c.healthValidUntil&&c.healthValidUntil>this.clock(),'EXPIRED_HEALTH','健康证已过期');ensure(Array.isArray(b.checks)&&['identity','health','skill','conduct'].every(k=>b.checks.includes(k)),'CHECKS_REQUIRED','四维审核缺项');}
      if(b.status==='APPROVED')ensure(await tx.order.count({where:{acceptedChefId:id,fulfillmentStatus:'COMPLETED'}})>=3,'TRIAL_REQUIRED','需完成前三单试岗');
      const row=await tx.chef.update({where:{id},data:{status:b.status,acceptingOrders:['TRIAL','APPROVED'].includes(b.status),data:{...obj(c.data),reviewReason:text(b.reason,'审核说明',500),reviewedAt:this.clock().toISOString()}}});
      await this.audit(tx,user.id,'CHEF_REVIEWED',id,{status:b.status,reason:b.reason,checks:b.checks??[]});return row;
    });
  }
  async opsTickets(user:User){this.role(user,'CUSTOMER_SERVICE','FINANCE_MANAGER','FINANCE','RISK','ADMIN');return this.db.serviceTicket.findMany({orderBy:{createdAt:'desc'}});}
  async decideTicket(user:User,id:string,b:Data){
    return this.transaction(async tx=>{
      const t=await tx.serviceTicket.findUnique({where:{id}});ensure(t,'NOT_FOUND','工单不存在',404);const o=await tx.order.findUniqueOrThrow({where:{id:t.orderId}});
      if(b.action==='propose'){
        this.role(user,'CUSTOMER_SERVICE');ensure(t.status==='OPEN','INVALID_STATE','工单不可重复建议');
        const refundFen=integer(b.refundFen,'退款金额',0,o.receivedFen-o.refundedFen);
        await tx.serviceTicket.update({where:{id},data:{status:'PROPOSED',refundFen,proposedBy:user.id,decision:text(b.decision,'裁定建议',1000)}});
      }else if(b.action==='approve'){
        this.role(user,'FINANCE_MANAGER');ensure(t.status==='PROPOSED'&&t.proposedBy!==user.id,'SEPARATION_REQUIRED','需要独立审批人');
        await tx.serviceTicket.update({where:{id},data:{status:'APPROVED',approvedBy:user.id}});
      }else if(b.action==='execute'){
        this.role(user,'FINANCE');ensure(t.status==='APPROVED'&&t.approvedBy!==user.id&&t.proposedBy!==user.id,'SEPARATION_REQUIRED','需要独立财务执行人');
        const refundFen=t.refundFen??0,settled=o.settlementStatus==='SETTLED';
        if(settled)await this.applyRecovery(tx,o,refundFen,id);
        await this.refund(tx,o,refundFen,'ticket:'+id);
        const remaining=o.receivedFen-o.refundedFen-refundFen;
        // A financial ruling closes this service with the approved net amount. An already settled order keeps its settlement record; the recovery entry is separate.
        await tx.order.update({where:{id:o.id},data:{contractStatus:o.confirmedAt?'FULFILLED':'CANCELLED',aftersaleStatus:'CLOSED',feeStatus:'SETTLED',fulfillmentStatus:o.confirmedAt?'COMPLETED':'STOPPED',balanceFen:0,settlementStatus:settled?'SETTLED':remaining>0?'PENDING':'INELIGIBLE',details:{...obj(o.details),adjudicated:true,adjudicatedNetFen:remaining}}});
        if(remaining===0)await tx.coupon.updateMany({where:{orderId:o.id},data:{status:'AVAILABLE',orderId:null}});
        await tx.bookingLock.deleteMany({where:{orderId:o.id}});await tx.chefOrder.updateMany({where:{orderId:o.id,status:'INVITED'},data:{status:'EXPIRED'}});
        await tx.insurancePolicy.updateMany({where:{orderId:o.id},data:{status:'SANDBOX_CANCELLED'}});
        await tx.serviceTicket.update({where:{id},data:{status:'CLOSED',executedBy:user.id}});
      }else ensure(false,'INVALID_ACTION','工单操作无效',400);
      await this.audit(tx,user.id,'TICKET_'+b.action.toUpperCase(),o.id,{ticketId:id});return tx.serviceTicket.findUnique({where:{id}});
    });
  }
  /**
   * Books the chef clawback for a refund on an order that was already settled.
   * Sandbox records an append-only ledger entry. Real wallet and WeChat-split orders are handled by ChefFinanceService.
   */
  async applyRecovery(tx:Tx,o:Order,refundFen:number,ticketId:string){
    const settlement=obj(obj(o.details).settlement);
    ensure(settlement.provider==='sandbox'&&Number.isSafeInteger(settlement.chefFen),'RECOVERY_REQUIRED','已结算订单退款前必须先入账厨师追偿');
    const plan=this.recoveryPlan(o,refundFen,settlement.chefFen);
    if(!await tx.ledgerEntry.findUnique({where:{reference:'recovery:'+ticketId}})){
      await tx.ledgerEntry.create({data:{orderId:o.id,reference:'recovery:'+ticketId,kind:'CHEF_RECOVERY',amountFen:plan.recoveryFen}});
      if(plan.recoveryFen>0){const chef=await tx.chef.findUnique({where:{id:o.acceptedChefId!}});if(chef)await tx.notification.create({data:{userId:chef.userId,orderId:o.id,body:'售后裁定退款 '+(refundFen/100).toFixed(2)+' 元，其中 '+(plan.recoveryFen/100).toFixed(2)+' 元从你的收入中扣回'}});}
      await this.audit(tx,null,'CHEF_RECOVERY_POSTED',o.id,{ticketId,recoveryFen:plan.recoveryFen,chefFen:plan.chefFen});
    }
    return plan;
  }
  recoveryPlan(o:Order,refundFen:number,paidChefFen:number){
    const d=obj(o.details),net=o.receivedFen-o.refundedFen-refundFen,subsidy=Number(d.discountFen??0);
    ensure(net>=0&&Number.isSafeInteger(paidChefFen)&&paidChefFen>=0,'INVALID_REFUND','追偿金额无效');
    const next=remainingChefFen(o.ruleSnapshot,Number(d.serviceFen)||0,net,subsidy);
    const recoveryFen=paidChefFen-next.chefFen;
    ensure(Number.isSafeInteger(next.chefFen)&&next.chefFen>=0&&recoveryFen>=0&&recoveryFen<=paidChefFen,'INVALID_ALLOCATION','追偿后厨师收入为负，请核对退款金额');
    return {...next,recoveryFen,net};
  }
  /** Shared settlement eligibility and allocation for completed orders and cancellation compensation. */
  async settlementAllocation(tx:Tx,o:Order,legacyHoldHours:number){
    const d=obj(o.details),rules=obj(o.ruleSnapshot),cancelled=o.contractStatus==='CANCELLED'&&d.cancelCompensationFen>0,adjudicated=d.adjudicated===true&&!cancelled;
    ensure(o.acceptedChefId,'NOT_FOUND','订单或厨师不存在',404);
    if(cancelled)ensure(o.settlementStatus==='PENDING'&&['NONE','CLOSED'].includes(o.aftersaleStatus),'SETTLEMENT_BLOCKED','取消补偿尚不满足结算条件');
    else if(adjudicated)ensure(o.settlementStatus==='PENDING'&&o.feeStatus==='SETTLED'&&['NONE','CLOSED'].includes(o.aftersaleStatus)&&o.balanceFen===0&&(o.contractStatus==='FULFILLED'||o.contractStatus==='CANCELLED'),'SETTLEMENT_BLOCKED','裁定订单尚不满足结算条件');
    else ensure(o.settlementStatus==='PENDING'&&o.feeStatus==='SETTLED'&&['NONE','CLOSED'].includes(o.aftersaleStatus)&&o.contractStatus==='FULFILLED'&&o.balanceFen===0&&o.confirmedAt,'SETTLEMENT_BLOCKED','订单尚不满足结算条件：未完成、费用未结清或存在争议');
    const eligibleAt=adjudicated&&!o.confirmedAt?new Date(0):this.settlementEligibleAt(o,legacyHoldHours);ensure(eligibleAt&&eligibleAt<=this.clock(),'SETTLEMENT_HOLD',rules.settlementTrigger==='REVIEW_OR_EXPIRE'?'订单需等待评价完成或评价期结束':rules.settlementTrigger==='CONFIRM_DELAY'?'订单未到结算时间':'订单仍在售后保护期');
    ensure(!d.pendingChange,'ALLOCATION_PENDING','变更订单需要单独确认分配');
    ensure(!await tx.serviceTicket.findFirst({where:{orderId:o.id,status:{not:'CLOSED'}}}),'SETTLEMENT_BLOCKED','订单存在未完结售后');
    ensure(!await tx.paymentRequest.findFirst({where:{orderId:o.id,kind:'REFUND',status:{not:'SUCCEEDED'}}}),'REFUND_PENDING','请等待退款确认完成');
    const net=o.receivedFen-o.refundedFen,rate=rules.commissionRate;
    ensure(Number.isFinite(rate)&&rate>=0&&rate<1&&Number.isSafeInteger(d.serviceFen),'INVALID_RATE','结算规则快照无效');
    if(cancelled)ensure(net===d.cancelCompensationFen,'FUNDS_MISMATCH','取消补偿金额与实收不一致');
    if(adjudicated)ensure(d.adjudicatedNetFen===net,'FUNDS_MISMATCH','裁定净额与实收不一致');
    const serviceBase=adjudicated?Math.min(d.serviceFen,net):d.serviceFen;
    const commission=cancelled?commissionFen(rules,net,net):commissionFen(rules,serviceBase,net),subsidyFen=cancelled?0:d.discountFen??0,chefFen=net+subsidyFen-commission;
    ensure(Number.isSafeInteger(chefFen)&&chefFen>=0&&Number.isSafeInteger(subsidyFen)&&subsidyFen>=0,'INVALID_ALLOCATION','结算金额异常');
    return {d,net,rate,commissionFen:commission,subsidyFen,chefFen,cancelled};
  }
  async settle(user:User,id:string){
    ensure(process.env.APP_MODE==='sandbox','SETTLEMENT_UNAVAILABLE','结算渠道尚未开通',503);
    this.role(user,'FINANCE');
    return this.transaction(tx=>this.sandboxSettleTx(tx,id,user.id));
  }
  async sandboxSettleTx(tx:Tx,id:string,actorId:string|null){
    const o=await tx.order.findUnique({where:{id}});ensure(o,'NOT_FOUND','订单不存在',404);
    if(o.settlementStatus==='SETTLED')return {ok:true};
    const {d,chefFen,commissionFen,subsidyFen}=await this.settlementAllocation(tx,o,168);
    await tx.ledgerEntry.create({data:{orderId:id,reference:'settlement:'+id,kind:'SETTLEMENT',amountFen:-chefFen}});
    if(subsidyFen)await tx.ledgerEntry.create({data:{orderId:id,reference:'subsidy:'+id,kind:'PLATFORM_SUBSIDY',amountFen:subsidyFen}});
    await tx.order.update({where:{id},data:{settlementStatus:'SETTLED',details:{...d,settlement:{chefFen,commissionFen,subsidyFen,provider:'sandbox',settledAt:this.clock().toISOString(),auto:!actorId}}}});
    await this.audit(tx,actorId,'SANDBOX_SETTLED',id,{chefFen,commissionFen,subsidyFen});return {chefFen,commissionFen,subsidyFen,sandbox:true};
  }
  async publishRules(user:User,b:Data){
    this.role(user,'ADMIN');
    ensure(Number.isFinite(b.commissionRate)&&b.commissionRate>=0&&b.commissionRate<1,'INVALID_RATE','佣金比例无效',400);
    integer(b.matchMinutes,'流拍分钟',1,30);integer(b.radiusM,'服务半径',100,10000);integer(b.urgentMinMinutes,'急单提前分钟',15,120);integer(b.settlementDelayHours??0,'评价后结算延迟',0,720);integer(b.couponFen,'券额',0,100000);integer(b.couponMinFen,'用券门槛',0,1000000);
    const s=srsInput(b);
    ensure(Array.isArray(b.regions)&&b.regions.length>0&&b.regions.every((r:Data)=>typeof r.code==='string'&&typeof r.name==='string'&&typeof r.active==='boolean'),'INVALID_REGIONS','片区配置无效',400);
    const data={...s,commissionRate:b.commissionRate,matchMinutes:b.matchMinutes,radiusM:b.radiusM,urgentMinMinutes:b.urgentMinMinutes,autoConfirmHours:s.autoConfirmHours,settlementDelayHours:b.settlementDelayHours??0,couponFen:b.couponFen,couponMinFen:b.couponMinFen,couponEnabled:b.couponEnabled===true,regions:b.regions,sandbox:process.env.APP_MODE==='sandbox'};
    return this.transaction(async tx=>{const row=await tx.platformRule.create({data:{id:'rules-'+randomUUID(),data,publishedBy:user.id}});await this.audit(tx,user.id,'RULES_PUBLISHED',row.id,{reason:text(b.reason,'变更原因',500)});return row;});
  }
}