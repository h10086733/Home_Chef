import Taro from '@tarojs/taro';
declare const API_BASE:string;
const base=process.env.TARO_ENV==='h5'?'/api':API_BASE;
export const money=(v:number=0)=>'¥'+(v/100).toFixed(2);
export const dateText=(v:string)=>new Date(v).toLocaleString('zh-CN',{hour12:false});
export const names:Record<string,string>={PENDING_PAYMENT:'待支付',UNPAID:'未支付',PENDING_ACCEPTANCE:'待接单',ACCEPTED:'已接单',FULFILLED:'已履约',CANCELLED:'已取消',READY:'待服务',DEPARTED:'已出发',ARRIVED:'已到达',SERVING:'服务中',AWAITING_CONFIRMATION:'待确认',COMPLETED:'已完成',STOPPED:'已中止',INELIGIBLE:'未满足条件',ESTIMATE_CONFIRMED:'预估已确认',AWAITING_PAYMENT:'待补款',SETTLED:'已结清',NONE:'无售后',PROCESSING:'处理中',CLOSED:'已关闭',FROZEN:'冻结',PENDING:'待结算',OPEN:'待处理',REVIEWED:'已评价',DEPOSIT_PAID:'已付定金',FULLY_PAID:'已付全款',FULLY_REFUNDED:'全额退款',PARTIALLY_REFUNDED:'部分退款',TRIAL:'新入驻',APPROVED:'已通过',PENDING_REVIEW:'待审核',SUSPENDED:'已暂停',DISPUTED:'争议中'};
export async function api(path:string,body?:any){
 const r=await Taro.request({url:base+path,method:body===undefined?'GET':'POST',header:{'content-type':'application/json',authorization:'Bearer '+(Taro.getStorageSync('token')??'')},data:body,timeout:20000});
 if(r.statusCode>=400){if(r.statusCode===401)Taro.removeStorageSync('token');throw new Error(r.data.error?.message??'请求失败');}return r.data;
}
export async function uploadImage(orderId?:string){
 const selected=await Taro.chooseImage({count:1,sizeType:['compressed'],sourceType:['album','camera']}),filePath=selected.tempFilePaths[0];
 let base64:string,mime='image/jpeg';
 if(process.env.TARO_ENV==='h5'){
  const blob=await(await fetch(filePath)).blob();mime=blob.type;
  base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
 }else{
  base64=await new Promise<string>((resolve,reject)=>Taro.getFileSystemManager().readFile({filePath,encoding:'base64',success:r=>resolve(r.data as string),fail:reject}));
  if(base64.startsWith('iVBOR'))mime='image/png';
 }
 return api('/files',{base64,mime,orderId});
}
