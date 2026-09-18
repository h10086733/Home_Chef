import {createHmac,randomBytes} from 'node:crypto';
import type {User} from '@prisma/client';
import type {Service} from './service';
import {ApiError,ensure,text} from './errors';
import {digest,encrypt} from './security';
export class WechatIdentity {
 private token?:{value:string;until:number};
 private loading?:Promise<string>;
 constructor(readonly appId=process.env.WECHAT_APP_ID??'',private readonly secret=process.env.WECHAT_APP_SECRET??'',private readonly transport:typeof fetch=fetch){}
 private configured(){ensure(process.env.WECHAT_LOGIN_ENABLED==='true'&&/^wx[a-f0-9]{16}$/i.test(this.appId)&&this.secret,'WECHAT_LOGIN_UNAVAILABLE','微信手机号登录尚未配置',503);}
 private async call(path:string,body?:unknown){
  try{const response=await this.transport('https://api.weixin.qq.com'+path,{method:body?'POST':'GET',...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000),redirect:'error'});ensure(response.ok,'WECHAT_AUTH_NETWORK','微信认证暂不可用，请重试',503);return await response.json() as any;}
  catch(e){if(e instanceof ApiError)throw e;throw new ApiError(503,'WECHAT_AUTH_NETWORK','微信认证暂不可用，请重试');}
 }
 private async accessToken():Promise<string>{
  if(this.token&&this.token.until>Date.now())return this.token.value;
  if(this.loading)return this.loading;
  this.loading=(async()=>{const r=await this.call('/cgi-bin/stable_token',{grant_type:'client_credential',appid:this.appId,secret:this.secret,force_refresh:false});ensure(!r.errcode&&typeof r.access_token==='string'&&Number.isFinite(r.expires_in)&&r.expires_in>120,'WECHAT_AUTH_CONFIG','微信认证服务配置异常',503);this.token={value:r.access_token,until:Date.now()+(r.expires_in-120)*1000};return r.access_token as string;})();
  try{return await this.loading;}finally{this.loading=undefined;}
 }
 async verify(loginCode:unknown,phoneCode:unknown){
  this.configured();const code=text(loginCode,'微信登录凭证',256),phone=text(phoneCode,'手机号授权凭证',256);
  const session=await this.call('/sns/jscode2session?'+new URLSearchParams({appid:this.appId,secret:this.secret,js_code:code,grant_type:'authorization_code'}));
  ensure(!session.errcode&&typeof session.openid==='string'&&session.openid.length>0,'WECHAT_LOGIN_INVALID','微信登录凭证无效，请重新授权',401);
  const getPhone=async()=>this.call('/wxa/business/getuserphonenumber?access_token='+encodeURIComponent(await this.accessToken()),{code:phone});
  let result=await getPhone();if([40001,40014,42001].includes(result.errcode)){this.token=undefined;result=await getPhone();}
  const info=result.phone_info;
  ensure(!result.errcode&&info?.watermark?.appid===this.appId&&/^\d{1,3}$/.test(info.countryCode)&&/^\d{5,14}$/.test(info.purePhoneNumber),'WECHAT_PHONE_INVALID','手机号授权无效，请重新点击授权按钮',400);
  const number='+'+info.countryCode+info.purePhoneNumber;ensure(/^\+[1-9]\d{6,14}$/.test(number),'WECHAT_PHONE_INVALID','手机号格式无效',400);
  return {openId:session.openid as string,phone:number};
 }
}
export async function wechatPhoneLogin(service:Service,identity:WechatIdentity,b:any,existing?:User){
 ensure(b.consent===true,'CONSENT_REQUIRED','请同意授权手机号用于账号登录',400);
 const verified=await identity.verify(b.loginCode,b.phoneCode);
 const key=process.env.DATA_KEY;ensure(key&&/^[a-f0-9]{64}$/i.test(key),'AUTH_CONFIG','账号加密配置异常',503);
 const lookup=createHmac('sha256',Buffer.from(key,'hex')).update('phone:'+verified.phone).digest('hex');
 return service.transaction(async tx=>{
  const byWechat=await tx.user.findUnique({where:{openId:verified.openId}});
  const byPhone=await tx.user.findFirst({where:{OR:[{phone:lookup},{phone:verified.phone},{phone:verified.phone.replace(/^\+86/,'')}]}});
  let user=existing?await tx.user.findUniqueOrThrow({where:{id:existing.id}}):byWechat;
  ensure(!byWechat||!existing||byWechat.id===existing.id,'WECHAT_BOUND','该微信已绑定其他账号，不能合并',409);
  ensure(!byPhone||user?.id===byPhone.id,'PHONE_BOUND','该手机号已绑定其他账号，请先登录原账号绑定微信',409);
  ensure(!user?.openId||user.openId===verified.openId,'WECHAT_BOUND','当前账号已绑定其他微信',409);
  ensure(!user?.phone||user.phone===lookup||user.id===byPhone?.id,'PHONE_CHANGE_REQUIRED','此账号已绑定其他手机号，请联系平台处理换绑',409);
  const data={openId:verified.openId,phone:lookup,phoneEncrypted:encrypt(verified.phone),phoneVerifiedAt:service.clock()};
  user=user?await tx.user.update({where:{id:user.id},data}):await tx.user.create({data:{...data,displayName:'微信用户',roles:['USER']}});
  const token=randomBytes(32).toString('hex');await tx.appSession.create({data:{id:digest(token),userId:user.id,expiresAt:new Date(service.clock().getTime()+24*3600000)}});
  await service.audit(tx,user.id,'WECHAT_PHONE_LOGIN',user.id,{phoneVerified:true});
  return {token,user:service.publicUser(user)};
 });
}