import {useEffect,useRef,useState} from 'react';
import {View,Text,Button,Picker,Switch,Input} from '@tarojs/components';
import {api,money,dateText,names,uploadImage} from '../../api';
import {chooseMapLocation,type MapPoint} from '../../maps';
import {halfHours} from './bookable';
import {ChefIncome} from './income';
import {ChefCertificates} from './certificates';
type R=Record<string,any>;
function dayAfter(days:number){return new Date(Date.now()+days*86400000+8*3600000).toISOString().slice(0,10);}
function dateOnly(value?:string){return value?new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10):'';}
export function ChefWorkbench({chef,regions,busy,run}:{chef:R|null,regions:R[],busy:boolean,run:(fn:()=>Promise<any>)=>Promise<any>}){
 const editable=!chef||['PENDING_REVIEW','REJECTED'].includes(chef.status);
 const canManage=!!chef&&['TRIAL','APPROVED'].includes(chef.status);
 const[form,setForm]=useState<R>({bio:'',cuisines:['湘菜'],regionCode:'',healthValidUntil:'',insuranceValidUntil:'',agreement:false});
 const[point,setPoint]=useState<MapPoint|null>(null);
 const[slot,setSlot]=useState({startDay:dayAfter(1),startClock:'10:00',endDay:dayAfter(1),endClock:'14:00'});
 const[packageName,setPackageName]=useState('四菜一汤'),[price,setPrice]=useState('198');
 const hydrated=useRef('');
 useEffect(()=>{
  const mark=(chef?.id??'new')+':'+(chef?.status??'');
  if(hydrated.current===mark)return;
  hydrated.current=mark;
  const data=chef?.data??{};
  const region=regions.some(item=>item.code===data.regionCode)?data.regionCode:regions[0]?.code??'';
  setForm({bio:data.bio??'',cuisines:data.cuisines?.length?data.cuisines:['湘菜'],regionCode:region,healthValidUntil:dateOnly(chef?.healthValidUntil),insuranceValidUntil:dateOnly(chef?.insuranceValidUntil),healthAssetId:data.healthAssetId,insuranceAssetId:data.insuranceAssetId,agreement:false});
  if(Number.isFinite(data.latitude)&&Number.isFinite(data.longitude))setPoint({name:'已保存的接单出发位置',address:'可重新选点调整',latitude:data.latitude,longitude:data.longitude,coordinateSystem:'GCJ02'});
 },[chef,regions]);
 const regionCode=regions.some(item=>item.code===form.regionCode)?form.regionCode:regions[0]?.code??'';
 useEffect(()=>{if(regionCode!==form.regionCode)setForm(current=>({...current,regionCode}));},[regionCode,form.regionCode]);
 const next=chef?.status==='REJECTED'?'补齐材料并重新提交审核':chef?.status==='PENDING_REVIEW'?'可以修改材料后再次提交，或等待审核':canManage?'发布套餐并添加可服务档期':'先完成资料、健康证和意外险';
 const ready=regions.some(item=>item.code===form.regionCode)&&!!point&&String(form.bio??'').trim()&&form.healthValidUntil&&form.healthAssetId&&form.insuranceValidUntil&&form.insuranceAssetId&&form.agreement;
 return <View>
  <View className="card"><Text className="heading">做饭赚收入</Text><Text className="hint">收入取决于实际订单，不承诺保底。{next}</Text>{chef&&<Text className="badge">{names[chef.status]??chef.status}</Text>}{chef?.data?.reviewReason&&<Text>{chef.data.reviewReason}</Text>}</View>
  {canManage&&<ChefIncome/>}
  {chef&&chef.status!=='BANNED'&&<ChefCertificates chef={chef}/>}
  {canManage&&<View className="card"><Text className="heading">套餐与档期</Text><Text className="hint">用户只能约到这里发布的时间。上门服务前后各需 1 小时缓冲，例如预约 11:00–13:00，请设置 10:00–14:00。</Text>{chef.packages.map((item:R)=><Text key={item.id}>{item.name} · {money(item.serviceFen)}</Text>)}<Field label="新套餐名称" value={packageName} onChange={setPackageName}/><Field label="服务价格（元）" value={price} onChange={setPrice}/><Button disabled={busy} onClick={()=>void run(()=>api('/chef/packages',{name:packageName,serviceFen:Math.round(Number(price)*100),description:'备菜、烹饪、装盘、基础台面清理与餐具归位'}))}>新增套餐</Button>{(chef.schedules??[]).map((item:R)=><Text key={item.id} className="hint">{dateText(item.startsAt)} — {dateText(item.endsAt)}</Text>)}<Picker mode="date" value={slot.startDay} onChange={e=>setSlot({...slot,startDay:e.detail.value})}><View className="picker">开始日期：{slot.startDay} ▾</View></Picker><Picker mode="selector" range={halfHours} value={halfHours.indexOf(slot.startClock)} onChange={e=>setSlot({...slot,startClock:halfHours[Number(e.detail.value)]})}><View className="picker">开始时间：{slot.startClock} ▾</View></Picker><Picker mode="date" value={slot.endDay} onChange={e=>setSlot({...slot,endDay:e.detail.value})}><View className="picker">结束日期：{slot.endDay} ▾</View></Picker><Picker mode="selector" range={halfHours} value={halfHours.indexOf(slot.endClock)} onChange={e=>setSlot({...slot,endClock:halfHours[Number(e.detail.value)]})}><View className="picker">结束时间：{slot.endClock} ▾</View></Picker><Button disabled={busy} onClick={()=>void run(()=>api('/chef/schedules',{startsAt:slot.startDay+'T'+slot.startClock+':00+08:00',endsAt:slot.endDay+'T'+slot.endClock+':00+08:00'}))}>添加可服务档期</Button></View>}
  {editable&&<View className="card"><Text className="heading">{chef?'补充并重新提交材料':'申请成为厨师'}</Text>{regions.length?<Picker mode="selector" range={regions.map(item=>item.name)} value={Math.max(0,regions.findIndex(item=>item.code===form.regionCode))} onChange={e=>setForm({...form,regionCode:regions[Number(e.detail.value)].code})}><View className="picker">服务片区：{regions.find(item=>item.code===form.regionCode)?.name??'请选择'} ▾</View></Picker>:<Text className="hint">暂无开放的服务片区</Text>}<Button onClick={()=>void run(async()=>{const picked=await chooseMapLocation(point);if(picked)setPoint(picked);})}>{point?'重新选择接单出发位置':'地图选择接单出发位置'}</Button>{point&&<Text className="hint">{point.name} · {point.address}</Text>}<Field label="擅长菜系（多个用逗号分隔）" value={(form.cuisines??[]).join('，')} onChange={value=>setForm({...form,cuisines:value.split(/[,，、]/).map(item=>item.trim()).filter(Boolean)})}/><Field label="自我介绍" value={form.bio} onChange={value=>setForm({...form,bio:value})}/><Picker mode="date" value={form.healthValidUntil||dayAfter(30)} onChange={e=>setForm({...form,healthValidUntil:e.detail.value})}><View className="picker">健康证有效期：{form.healthValidUntil||'请选择'} ▾</View></Picker><Button disabled={busy} onClick={()=>void run(async()=>{const file=await uploadImage();setForm(current=>({...current,healthAssetId:file.id}));})}>{form.healthAssetId?'健康证明已保存，可重新上传':'上传健康证明'}</Button><Picker mode="date" value={form.insuranceValidUntil||dayAfter(30)} onChange={e=>setForm({...form,insuranceValidUntil:e.detail.value})}><View className="picker">意外险有效期：{form.insuranceValidUntil||'请选择'} ▾</View></Picker><Button disabled={busy} onClick={()=>void run(async()=>{const file=await uploadImage();setForm(current=>({...current,insuranceAssetId:file.id}));})}>{form.insuranceAssetId?'意外险已保存，可重新上传':'上传意外险保单'}</Button><View className="row"><Text>同意服务边界、审核与试岗</Text><Switch checked={!!form.agreement} onChange={e=>setForm({...form,agreement:e.detail.value})}/></View><Button className="primary" disabled={!ready||busy} onClick={()=>void run(()=>api('/chef/profile',{...form,healthValidUntil:form.healthValidUntil+'T23:59:59+08:00',insuranceValidUntil:form.insuranceValidUntil+'T23:59:59+08:00',latitude:point?.latitude,longitude:point?.longitude,coordinateSystem:'GCJ02'}))}>提交审核</Button></View>}
  {chef&&!editable&&!canManage&&<View className="card"><Text className="hint">当前状态不能重新提交入驻或发布套餐，请联系运营。</Text></View>}
 </View>;
}
function Field({label,value,onChange}:{label:string,value:string,onChange:(value:string)=>void}){
 return <View className="field"><Text>{label}</Text><Input value={value} onInput={event=>onChange(event.detail.value)}/></View>;
}
