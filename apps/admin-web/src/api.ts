export type Row=Record<string,any>;
export const money=(fen:number=0)=>'¥'+(fen/100).toFixed(2);
export const time=(value:string)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
export const labels:Record<string,string>={PENDING_PAYMENT:'待支付',UNPAID:'未支付',PENDING_ACCEPTANCE:'待接单',ACCEPTED:'已接单',FULFILLED:'已履约',CANCELLED:'已取消',DEPOSIT_PAID:'已付定金',FULLY_PAID:'已付全款',FULLY_REFUNDED:'全额退款',PARTIALLY_REFUNDED:'部分退款',INELIGIBLE:'未满足条件',READY:'待服务',DEPARTED:'已出发',ARRIVED:'已到达',SERVING:'服务中',AWAITING_CONFIRMATION:'待确认',COMPLETED:'已完成',STOPPED:'已中止',ESTIMATE_CONFIRMED:'预估已确认',AWAITING_PAYMENT:'待补尾款',SETTLED:'已结清',NONE:'无售后',PROCESSING:'处理中',CLOSED:'已关闭',FROZEN:'冻结',PENDING:'待结算',OPEN:'待处理',PROPOSED:'待审批',APPROVED:'已通过',TRIAL:'新入驻',PENDING_REVIEW:'待审核',REJECTED:'已驳回',SUSPENDED:'已暂停',REVIEWED:'已评价',DISPUTED:'争议中',EXPIRED:'已过期'};
export async function api(path:string,body?:unknown,method?:string){
 const r=await fetch('/api'+path,{method:method??(body===undefined?'GET':'POST'),headers:{'Content-Type':'application/json',Authorization:'Bearer '+(localStorage.getItem('home-chef-token')??'')},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await r.json();if(!r.ok){if(r.status===401){localStorage.removeItem('home-chef-token');window.dispatchEvent(new Event('session-expired'));}throw new Error(data.error?.message??'请求失败');}return data;
}
export async function upload(file:File,orderId?:string){
 if(file.size>3*1024*1024)throw new Error('图片不能超过3MB');
 const base64=await new Promise<string>((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(String(r.result).split(',')[1]);r.onerror=reject;r.readAsDataURL(file);});
 return api('/files',{mime:file.type,base64,orderId});
}
