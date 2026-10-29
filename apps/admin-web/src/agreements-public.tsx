import {useEffect,useState} from 'react';
import {api} from './api';
export function PublicAgreements(){
 const[rows,setRows]=useState<any[]>([]);
 useEffect(()=>{let live=true;void api('/agreements').then(list=>{if(live)setRows(list);}).catch(()=>{if(live)setRows([]);});return()=>{live=false;};},[]);
 const preferred=rows.filter(row=>row.kind==='USER_SERVICE'||row.kind==='PRIVACY');
 const list=preferred.length?preferred:rows;
 if(!list.length)return <p className="muted">平台暂未发布在线协议。</p>;
 return <div>{list.map(row=><section key={row.id}><strong>{row.title}（第 {row.version} 版）</strong><p className="muted" style={{whiteSpace:'pre-wrap',maxHeight:180,overflow:'auto'}}>{row.content}</p></section>)}</div>;
}
