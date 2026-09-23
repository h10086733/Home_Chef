import {useEffect,useState} from 'react';
import {Button,Input,Select} from 'antd';
import {api,type Row} from './api';
import {useData,Field,QueryState,type Run} from './ui';
import {MapField,fullMapAddress,type MapPoint} from './map-field';
export function AddressForm({run,onSaved}:{run:Run;onSaved:(address:Row)=>Promise<void>}){
 const rules=useData('/rules'),[point,setPoint]=useState<MapPoint|null>(null),[door,setDoor]=useState(''),[region,setRegion]=useState(''),[busy,setBusy]=useState(false);
 const regions:Row[]=(rules.data?.regions??[]).filter((r:Row)=>r.active);
 useEffect(()=>{setRegion(current=>regions.some(r=>r.code===current)?current:regions[0]?.code??'');},[rules.data]);
 return <><QueryState q={rules}/><Field label="服务片区"><Select value={region||undefined} placeholder="暂无开放的服务片区" onChange={setRegion} options={regions.map(r=>({value:r.code,label:r.name}))}/></Field><MapField value={point} onChange={p=>{setPoint(p);setDoor('');}}/><Field label="楼栋 / 单元 / 门牌号"><Input value={door} placeholder="例如：3栋2单元602室" onChange={e=>setDoor(e.target.value)}/></Field><Button type="primary" loading={busy} disabled={!point||!door.trim()||!regions.some(r=>r.code===region)} onClick={()=>{if(busy)return;setBusy(true);void run(async()=>{if(!point)return;const address=await api('/addresses',{label:'家',regionCode:region,...point,fullText:fullMapAddress(point,door)});await onSaved(address);}).finally(()=>setBusy(false));}}>保存地址并选择</Button></>;
}
