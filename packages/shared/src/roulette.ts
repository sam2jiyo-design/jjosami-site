export type Identity={idx:string;preset:string;soop:string;endpoint:string};
export type RouletteResult={source:'weflab';sourceEventId:string|null;drawIndex:number|null;platform:string;soop:string;nickname:string;itemName:string;donation:number|null;occurredAt:string|null;receivedAt:string;status:'ready'|'review_required'|'ignored';reason:string};
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
const flagged=(v:unknown)=>v===true||v===1||v==='1'||v==='true';
export function normalizeResults(message:any,identity:Identity):RouletteResult[]{
 if(!message||typeof message!=='object'||Array.isArray(message))return [];if(!['roulette','alertlist','test_donation','alert_replay'].includes(message.type))return [];
 const d=message.data;if(!d||typeof d!=='object'||Array.isArray(d))return [];if(message.idx!==undefined&&String(message.idx)!==identity.idx||d.bjid!==undefined&&d.bjid!==identity.soop&&d.bjid!=='test')return [];
 const first=text(d.roulette);if(!first)return [];let draws:any=[[first,d.percent]],invalid=false;
 if(d.list!==undefined&&d.list!==null&&d.list!==''){try{draws=typeof d.list==='string'?JSON.parse(d.list):d.list}catch{draws=null}if(!Array.isArray(draws)||!draws.length||draws.length>200||draws.some((x:any)=>!Array.isArray(x)||!text(x[0]))||draws[0][0]!==first){draws=[[first]];invalid=true}}
 const ignored=['test_donation','alert_replay'].includes(message.type)||[message.test,message.replay,d.test,d.replay].some(flagged)||['test','replay'].includes(d.mode)||d.bjid==='test'||message.id==='test';
 const platform=text(d.platform||message.platform),soop=text(d.id),nickname=text(d.name),sourceEventId=text(d.uid),donation=Number(d.value),mode=d.mode===undefined?'live':d.mode;
 const reason=ignored?'테스트 또는 재생 결과':invalid?'연차 결과 형식을 확인할 수 없습니다.':mode!=='live'?'실제 후원 여부를 확인할 수 없습니다.':platform!=='afreeca'?'SOOP 외 플랫폼 결과입니다.':!sourceEventId||sourceEventId.length>300?'고유 이벤트 ID를 확인할 수 없습니다.':!soop||!nickname||soop.length>100||nickname.length>100?'후원자 식별 정보를 확인할 수 없습니다.':!Number.isFinite(donation)||donation<=0?'후원 수량을 확인할 수 없습니다.':'';
 return draws.map((x:any,index:number)=>({source:'weflab',sourceEventId:sourceEventId.slice(0,300)||null,drawIndex:invalid?null:index,platform:platform.slice(0,30),soop:soop.slice(0,100),nickname:nickname.slice(0,100),itemName:text(x[0]).slice(0,200),donation:Number.isFinite(donation)&&donation>0?donation:null,occurredAt:text(d.create_time).slice(0,100)||null,receivedAt:new Date().toISOString(),status:ignored?'ignored':reason?'review_required':'ready',reason}));
}
export function packetEvent(raw:string){if(!raw.startsWith('42'))return null;try{const event=JSON.parse(raw.slice(2));return Array.isArray(event)&&event[0]==='msg'?event[1]:null}catch{return null}}
