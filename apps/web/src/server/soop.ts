// SOOP's station frontend uses this endpoint (verified 2026-09-28).
// A successful empty response means offline; an HTTP error never does.
export const SOOP_BROADCAST_ORIGIN='https://api-channel.sooplive.com';
export async function readSoopBroadcast(channel:string,request:typeof fetch=fetch){
 if(!/^[A-Za-z0-9_-]+$/.test(channel))throw Error('INVALID_SOOP_CHANNEL');
 const response=await request(`${SOOP_BROADCAST_ORIGIN}/v1.1/channel/${channel}/home/section/broad`,{
  headers:{Accept:'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(7000)
 });
 if(response.status!==200)throw Error('SOOP_HTTP_'+response.status);
 const reader=response.body?.getReader(),decoder=new TextDecoder();let body='',size=0;
 try{if(reader)while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.length;if(size>262144)throw Error('SOOP_RESPONSE_TOO_LARGE');body+=decoder.decode(chunk.value,{stream:true})}body+=decoder.decode()}finally{await reader?.cancel().catch(()=>{})}
 const offline={status:'offline' as const,title:null,thumbnailUrl:null,broadcastUrl:null};
 if(!body.trim())return offline;
 let data;try{data=JSON.parse(body)}catch{throw Error('SOOP_INVALID_RESPONSE')}
 if(data===null||typeof data==='object'&&Object.keys(data).length===0)return offline;
 if(typeof data!=='object'||data.userId!==channel||typeof data.broadTitle!=='string'||!/^[1-9]\d*$/.test(String(data.broadNo)))throw Error('SOOP_INVALID_RESPONSE');
 return {status:'live' as const,title:data.broadTitle.slice(0,300),thumbnailUrl:null,broadcastUrl:`https://play.sooplive.com/${channel}/${data.broadNo}`};
}
