import {useEffect,useState} from 'react';
import {View,Text} from '@tarojs/components';
import {api} from '../../api';
type R=Record<string,any>;
export function PublicAgreements(){
 const[rows,setRows]=useState<R[]|null>(null);
 useEffect(()=>{let live=true;void api('/agreements').then(list=>{if(live)setRows(list);}).catch(()=>{if(live)setRows([]);});return()=>{live=false;};},[]);
 const preferred=(rows??[]).filter(row=>row.kind==='USER_SERVICE'||row.kind==='PRIVACY');
 const list=preferred.length?preferred:(rows??[]);
 return <View className="agreement-preview">{rows===null?<Text className="hint">正在读取协议…</Text>:list.length?list.map(row=><View key={row.id}><Text className="heading">{row.title}（第 {row.version} 版）</Text><Text className="hint">{row.content}</Text></View>):<Text className="hint">平台暂未发布在线协议。勾选后仍表示同意《用户服务协议》和《隐私政策》。</Text>}</View>;
}
