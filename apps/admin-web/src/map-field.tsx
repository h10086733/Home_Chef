import {useState} from 'react';
import {Button,Alert} from 'antd';
import {api} from './api';
import {chooseBrowserLocation,type MapPoint} from '../../../packages/map-location/browser';
export type {MapPoint};
export {fullMapAddress} from '../../../packages/map-location/browser';
export function MapField({value,onChange,label='地图选择服务地址'}:{value:MapPoint|null;onChange:(point:MapPoint)=>void;label?:string}){
 const[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function choose(){if(busy)return;setBusy(true);setError('');try{const point=await chooseBrowserLocation(await api('/maps/config'),value);if(point)onChange(point);}catch(e:any){setError(e.message);}finally{setBusy(false);}}
 return <div className="space"><Button block loading={busy} onClick={()=>void choose()}>{value?'重新地图选址':label}</Button>{value?<p><strong>{value.name}</strong><br/>{value.address}</p>:<p className="muted">搜索小区或街道，在地图上确认位置；门牌号在下方补充。</p>}{error&&<Alert type="warning" message={error} showIcon/>}</div>;
}
