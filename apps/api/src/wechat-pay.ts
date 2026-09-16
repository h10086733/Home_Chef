import {publicEncrypt,constants,createDecipheriv,createPrivateKey,createPublicKey,randomBytes,sign,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {ApiError,ensure} from './errors';
export type WechatConfig={appId:string;appSecret:string;mchId:string;serial:string;privateKey:string;apiKey:string;publicKeyId:string;publicKey:string;notifyUrl:string};
export function loadWechatConfig():WechatConfig|null{
 if(process.env.WECHAT_PAY_ENABLED!=='true')return null;
 const env=(n:string)=>{const v=process.env[n]?.trim();if(!v)throw new Error('Missing WeChat configuration: '+n);return v;};
 const c={appId:env('WECHAT_APP_ID'),appSecret:env('WECHAT_APP_SECRET'),mchId:env('WECHAT_MCH_ID'),serial:env('WECHAT_MCH_SERIAL'),privateKey:readFileSync(env('WECHAT_MCH_PRIVATE_KEY_PATH'),'utf8'),apiKey:env('WECHAT_API_V3_KEY'),publicKeyId:env('WECHAT_PAY_PUBLIC_KEY_ID'),publicKey:readFileSync(env('WECHAT_PAY_PUBLIC_KEY_PATH'),'utf8'),notifyUrl:env('WECHAT_PAY_NOTIFY_URL')};
 const u=new URL(c.notifyUrl);
 if(!/^wx[a-f0-9]{16}$/i.test(c.appId)||Buffer.byteLength(c.apiKey)!==32||u.protocol!=='https:'||u.search||u.hash||u.pathname!=='/api/payments/wechat/notify')throw new Error('Invalid WeChat payment configuration');
 if(createPrivateKey(c.privateKey).asymmetricKeyType!=='rsa'||createPublicKey(c.publicKey).asymmetricKeyType!=='rsa')throw new Error('WeChat payment requires RSA keys');return c;
}
export class WechatPay{
 constructor(readonly config:WechatConfig,readonly transport:typeof fetch=fetch,readonly now=()=>Date.now()){}
 encryptName(name:string){return publicEncrypt({key:this.config.publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha1'},Buffer.from(name)).toString('base64');}
 signature(message:string){return sign('RSA-SHA256',Buffer.from(message),this.config.privateKey).toString('base64');}
 verifyBody(h:Record<string,any>,body:string){
  const t=h['wechatpay-timestamp'],n=h['wechatpay-nonce'],s=h['wechatpay-signature'],serial=h['wechatpay-serial'];
  ensure(typeof t==='string'&&/^\d+$/.test(t)&&Math.abs(this.now()/1000-Number(t))<=300&&typeof n==='string'&&n.length>0&&typeof s==='string'&&serial===this.config.publicKeyId,'WECHAT_SIGNATURE','微信签名无效',401);
  ensure(verify('RSA-SHA256',Buffer.from(`${t}\n${n}\n${body}\n`),this.config.publicKey,Buffer.from(s,'base64')),'WECHAT_SIGNATURE','微信签名无效',401);
 }
 async request(method:string,path:string,data?:unknown):Promise<any>{
  const body=data===undefined?'':JSON.stringify(data),t=String(Math.floor(this.now()/1000)),n=randomBytes(16).toString('hex');
  const s=this.signature(`${method}\n${path}\n${t}\n${n}\n${body}\n`);
  const authorization=`WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${n}",timestamp="${t}",serial_no="${this.config.serial}",signature="${s}"`;
  let r:Response;try{r=await this.transport('https://api.mch.weixin.qq.com'+path,{method,body:body||undefined,headers:{Authorization:authorization,Accept:'application/json','Content-Type':'application/json','Wechatpay-Serial':this.config.publicKeyId},signal:AbortSignal.timeout(8000),redirect:'error'});}catch{throw new ApiError(503,'WECHAT_NETWORK','微信支付暂未响应，请稍后查询订单，不要重复付款');}
  const raw=await r.text();this.verifyBody(Object.fromEntries(r.headers.entries()),raw);const result=raw?JSON.parse(raw):{};
  if(!r.ok){const code=String(result.code??'ERROR').replace(/[^A-Z_]/g,'').slice(0,60);throw new ApiError(502,'WECHAT_'+code,'微信支付暂未完成，请稍后重试或联系平台');}return result;
 }
 async openId(code:string):Promise<string>{
  const q=new URLSearchParams({appid:this.config.appId,secret:this.config.appSecret,js_code:code,grant_type:'authorization_code'});
  let r:Response;try{r=await this.transport('https://api.weixin.qq.com/sns/jscode2session?'+q,{signal:AbortSignal.timeout(8000),redirect:'error'});}catch{throw new ApiError(503,'WECHAT_LOGIN','微信登录暂不可用');}
  const b:any=await r.json();ensure(r.ok&&!b.errcode&&typeof b.openid==='string'&&b.openid.length>0,'WECHAT_LOGIN','微信登录凭证已失效，请重新尝试',400);return b.openid;
 }
 clientParams(prepayId:string){const timeStamp=String(Math.floor(this.now()/1000)),nonceStr=randomBytes(16).toString('hex'),pkg='prepay_id='+prepayId;return {timeStamp,nonceStr,package:pkg,signType:'RSA' as const,paySign:this.signature(`${this.config.appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`)};}
 notification(h:Record<string,any>,raw:string,eventType='TRANSACTION.SUCCESS',originalType='transaction'){
  this.verifyBody(h,raw);const e=JSON.parse(raw),r=e.resource;
  ensure(e.event_type===eventType&&r?.algorithm==='AEAD_AES_256_GCM'&&r.original_type===originalType,'WECHAT_EVENT','不支持的微信通知',400);
  const encrypted=Buffer.from(r.ciphertext,'base64');ensure(encrypted.length>16,'WECHAT_EVENT','通知内容无效',400);
  const d=createDecipheriv('aes-256-gcm',Buffer.from(this.config.apiKey),Buffer.from(r.nonce));d.setAuthTag(encrypted.subarray(-16));d.setAAD(Buffer.from(r.associated_data??''));
  try{return JSON.parse(Buffer.concat([d.update(encrypted.subarray(0,-16)),d.final()]).toString('utf8'));}catch{throw new ApiError(400,'WECHAT_EVENT','通知解密失败');}
 }
}