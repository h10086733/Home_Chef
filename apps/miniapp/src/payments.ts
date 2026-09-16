import Taro from '@tarojs/taro';
import {api} from './api';
export async function payWithWechat(orderId:string,paymentChoice:'DEPOSIT'|'FULL_PAYMENT'|'BALANCE'){
 if(process.env.TARO_ENV!=='weapp')throw new Error('请在微信小程序中打开订单并使用微信支付');
 const login=await Taro.login();if(!login.code)throw new Error('无法获取微信登录凭证，请重试');
 await api('/auth/wechat/bind',{code:login.code});
 const p=await api('/orders/'+orderId+'/wechat-pay',{paymentChoice});
 let cancelled=false;
 try{await Taro.requestPayment({timeStamp:p.timeStamp,nonceStr:p.nonceStr,package:p.package,signType:'RSA',paySign:p.paySign});}
 catch(e:any){cancelled=String(e?.errMsg??'').includes('cancel');}
 // The client result never changes the order state. Only a signed server query/notification can do so.
 for(let i=0;i<4;i++){
  let result:any;try{result=await api('/payments/'+p.paymentId+'/status',{});}catch{break;}
  if(result.status==='SUCCEEDED'){await Taro.showToast({title:result.order.contractStatus==='PAYMENT_EXCEPTION'||result.order.contractStatus==='CANCELLED'?'款项已收到，正在退款':'微信付款已到账',icon:'none'});return;}
  if(result.status==='EXPIRED')break;
  if(cancelled)break;
  await new Promise(resolve=>setTimeout(resolve,1500));
 }
 await Taro.showToast({title:cancelled?'已退出收银台，请查看订单状态':'正在确认付款结果，请稍后查看订单',icon:'none'});
}