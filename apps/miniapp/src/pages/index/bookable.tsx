import {Picker,Text,View} from '@tarojs/components';
export const halfHours=Array.from({length:48},(_,i)=>String(Math.floor(i/2)).padStart(2,'0')+':'+(i%2?'30':'00'));
export function wallClock(iso:string){
 const shifted=new Date(new Date(iso).getTime()+8*3600000);
 return {day:shifted.toISOString().slice(0,10),clock:shifted.toISOString().slice(11,16)};
}
export function BookableTimes({times,day,clock,reason,onPick}:{times:string[],day:string,clock:string,reason?:string,onPick:(day:string,clock:string)=>void}){
 const parts=times.map(iso=>({...wallClock(iso)}));
 const days=[...new Set(parts.map(part=>part.day))];
 const clocks=parts.filter(part=>part.day===day).map(part=>part.clock);
 if(!times.length)return <Text className="hint">{reason||'还没有可约档期'}。上门服务约 2 小时，须落在厨师已发布档期内，并前后各留 1 小时。</Text>;
 return <>
  <Picker mode="selector" range={days} value={Math.max(0,days.indexOf(day))} onChange={e=>{const next=days[Number(e.detail.value)];const nextClock=parts.find(part=>part.day===next)?.clock??clock;onPick(next,nextClock);}}><View className="picker">可约日期：{days.includes(day)?day:'请选择'} ▾</View></Picker>
  <Picker mode="selector" range={clocks.length?clocks:['暂无']} value={Math.max(0,clocks.indexOf(clock))} onChange={e=>{if(clocks.length)onPick(day,clocks[Number(e.detail.value)]);}}><View className="picker">可约时间：{clocks.includes(clock)?clock:'请选择'}（整点/半点）▾</View></Picker>
  <Text className="hint">只显示厨师档期内、满足提前量的时间。服务约 2 小时，档期前后各留 1 小时。</Text>
 </>;
}
