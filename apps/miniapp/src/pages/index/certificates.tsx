import {useState} from 'react';
import {View,Text,Button,Picker} from '@tarojs/components';
import Taro from '@tarojs/taro';
import {api,uploadImage,dateText} from '../../api';
type R=Record<string,any>;
const kinds=[{kind:'HEALTH',name:'健康证',until:'healthValidUntil'},{kind:'INSURANCE',name:'意外险保单',until:'insuranceValidUntil'}];
export function ChefCertificates({chef}:{chef:R}){
 const[busy,setBusy]=useState(false),[error,setError]=useState(''),[form,setForm]=useState<R>({kind:'HEALTH',validUntil:'',assetId:''});
 const pending=chef.data?.pendingCerts??{};
 const run=async(fn:()=>Promise<any>)=>{if(busy)return;setBusy(true);setError('');try{await fn();}catch(e:any){setError(e.message);}finally{setBusy(false);}};
 const submit=()=>run(async()=>{
  if(!form.assetId)throw new Error('请先上传证照图片');if(!form.validUntil)throw new Error('请选择有效期');
  await api('/chef/certificates',{kind:form.kind,assetId:form.assetId,validUntil:new Date(form.validUntil+'T23:59:59+08:00').toISOString()});
  setForm({kind:form.kind,validUntil:'',assetId:''});await Taro.showToast({title:'已提交审核',icon:'none'});
 });
 return <View className="card"><Text className="heading">证照与保险</Text>
  {kinds.map(k=><Text key={k.kind}>{k.name}：{chef[k.until]?'有效期至 '+dateText(chef[k.until]):'未登记'}{pending[k.kind]?' · 新材料审核中':''}</Text>)}
  <Text className="hint">健康证到期后自动暂停接单；意外险到期后有 60 天缓冲期，缓冲期结束仍未更新将无法接单。新材料审核通过后自动生效。</Text>
  {error&&<Text className="error">{error}</Text>}
  <Picker mode="selector" range={kinds.map(k=>k.name)} onChange={e=>setForm({...form,kind:kinds[Number(e.detail.value)].kind})}><View className="picker">证照类型：{kinds.find(k=>k.kind===form.kind)!.name} ▾</View></Picker>
  <Picker mode="date" value={form.validUntil} onChange={e=>setForm({...form,validUntil:e.detail.value})}><View className="picker">有效期至：{form.validUntil||'请选择'} ▾</View></Picker>
  <Button size="mini" disabled={busy} onClick={()=>void run(async()=>setForm({...form,assetId:(await uploadImage()).id}))}>{form.assetId?'图片已上传':'上传证照图片'}</Button>
  <Button className="primary" loading={busy} onClick={()=>void submit()}>提交审核</Button>
 </View>;
}
