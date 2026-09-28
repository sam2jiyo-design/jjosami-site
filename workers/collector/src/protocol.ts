import {normalizeResults,type Identity} from '@jjosami/shared/roulette';

export type Channel='results'|'donations';
export const channels:Channel[]=['results','donations'];
export function subscription(channel:Channel,identity:Identity){
 const results=channel==='results',page=results?'setup':'page',pageid=results?'alertlist':'alert';
 return {
  url:(results?identity.endpoint:'https://ssafreeca.weflab.com')+'/socket.io/?'+new URLSearchParams({EIO:'4',transport:'websocket',idx:identity.idx,type:page,page:pageid}),
  join:{type:results?'join':'join_platform',page,idx:identity.idx,pageid,preset:identity.preset,...(results?{}:{platform:'afreeca',id:identity.soop})}
 };
}
const text=(value:unknown)=>typeof value==='string'?value.trim():'';
const flagged=(value:unknown)=>value===true||value===1||value==='1'||value==='true';
export type Donation={uid:string;platform:'afreeca';bjid:string;id:string;name:string;value:number;create_time:string;test:boolean;replay:boolean;mode:string};
export function donationDetails(message:any,identity:Identity):Donation|null{
 const data=message?.data;
 if(message?.type!=='alert'||!data||typeof data!=='object'||Array.isArray(data))return null;
 if((message.idx!==undefined&&String(message.idx)!==identity.idx)||(message.platform||data.platform)!=='afreeca'||(data.platform!==undefined&&data.platform!=='afreeca'))return null;
 const owner=message.id??data.bjid;
 if(owner!==identity.soop||(data.bjid!==undefined&&data.bjid!==identity.soop))return null;
 const uid=text(data.uid),id=text(data.id),name=text(data.name),value=Number(data.value);
 if(!uid||uid.length>300||!id||id.length>100||!name||name.length>100||!Number.isFinite(value)||value<=0)return null;
 const time=Number(data.time),date=new Date(time<1e12?time*1000:time);
 return {uid,platform:'afreeca',bjid:identity.soop,id,name,value,
  create_time:text(data.create_time)||(Number.isFinite(time)&&!Number.isNaN(date.getTime())?date.toISOString():''),
  test:flagged(message.test)||flagged(data.test),replay:flagged(message.replay)||flagged(data.replay),mode:data.mode===undefined?'live':String(data.mode)};
}
export function eventKey(identity:Identity,uid:string){return JSON.stringify([identity.idx,identity.preset,'afreeca',uid])}
// Keep only fields needed to identify and reconcile a result. Do not retain
// raw provider packets, chat text, profile information or alert page URLs.
export function resultEnvelope(message:any){
 const data:Record<string,unknown>={};
 for(const key of ['uid','roulette','percent','list','bjid','platform','id','name','value','create_time','test','replay','mode']){
  if(message.data?.[key]!==undefined)data[key]=message.data[key];
 }
 return {type:message.type,idx:message.idx,platform:message.platform,id:message.id==='test'?'test':undefined,test:message.test,replay:message.replay,data};
}
export function mergedResults(message:any,donation:Donation,identity:Identity){
 const data=message.data;
 // A later packet must never silently replace the observed donor or amount.
 const conflict=['id','name','bjid','uid','platform','value'].some(key=>data[key]!==undefined&&String(data[key])!==String(donation[key as keyof Donation]));
 return normalizeResults({...message,data:{...donation,...data,
  test:donation.test||flagged(data.test),replay:donation.replay||flagged(data.replay),
  mode:conflict?'conflict':donation.mode!=='live'?donation.mode:data.mode??'live'
 }},identity);
}
