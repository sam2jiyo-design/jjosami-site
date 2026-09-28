import 'server-only';
import {signedHeaders} from '@jjosami/shared/security';
import {AppError,dbError,env,rpc,serviceDb} from './db';
import {fetchPage,parseCatalog,parseAlertBootstrap,validateUrl} from './integrations/weflab-adapter.mjs';
export {validateUrl};
export async function collectorSettings(){const {data,error}=await serviceDb().from('site_settings').select('data,version').eq('id',true).single();dbError(error);return {catalogUrl:'',alertUrl:'',...data!.data,version:data!.version}}
export function requireLive(){if(process.env.LIVE_INTEGRATIONS_ENABLED!=='true'||process.env.VERCEL_ENV==='preview')throw new AppError('PROVIDER_DISABLED','이 환경에서는 실제 수집이 비활성화되어 있습니다.',503)}
export async function syncCatalog(){requireLive();const settings=await collectorSettings();if(!settings.catalogUrl)throw new AppError('INVALID_INPUT','룰렛 목록 URL을 먼저 저장해 주세요.');if(!await rpc<boolean>(serviceDb(),'claim_provider',{p_key:'weflab-catalog',p_milliseconds:30000}))throw new AppError('PROVIDER_RATE_LIMITED','룰렛 목록을 갱신 중입니다. 잠시 후 다시 시도해 주세요.',429);let catalog;try{catalog=parseCatalog(await fetchPage(settings.catalogUrl,'catalog'))}catch{throw new AppError('PROVIDER_UNAVAILABLE','룰렛 목록을 불러오지 못했습니다. URL과 공개 설정을 확인해 주세요.',503)}const {error}=await serviceDb().from('roulette_catalog').upsert({id:true,data:catalog,version:catalog.version,last_success_at:new Date().toISOString()});dbError(error);return catalog}
function record(value:unknown):Record<string,unknown>|null {
 return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
async function collectorResponse(response:Response):Promise<unknown> {
 const reader=response.body?.getReader();
 if(!reader)throw Error('EMPTY_RESPONSE');
 const chunks:Uint8Array[]=[];let size=0;
 try {
  while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw Error('RESPONSE_TOO_LARGE');chunks.push(part.value)}
 } finally {await reader.cancel().catch(()=>{})}
 const bytes=new Uint8Array(size);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
 return JSON.parse(new TextDecoder().decode(bytes));
}
const collectorErrorMessages:Record<string,string>={
 COLLECTOR_DISABLED:'Worker에서 수집이 비활성화되어 있습니다. 배포된 COLLECTOR_ENABLED 값이 문자열 true인지 확인해 주세요.',
 COLLECTOR_BINDING_MISSING:'Worker에 ROULETTE_COLLECTOR Durable Object 바인딩이 없거나 올바르지 않습니다.',
 COLLECTOR_STREAMER_KEY_MISSING:'Worker에 STREAMER_KEY가 설정되지 않았습니다.',
 COLLECTOR_INVALID_IDENTITY:'Worker가 후원 알림 연결 정보를 거부했습니다. 저장된 후원 알림 URL을 확인해 주세요.',
 COLLECTOR_INVALID_COMMAND:'Worker가 제어 요청 형식을 거부했습니다. 웹 서버와 Worker의 배포 버전을 확인해 주세요.',
 COLLECTOR_STORAGE_UNAVAILABLE:'Worker의 Durable Object 저장소에서 오류가 발생했습니다. Cloudflare 로그와 SQLite 마이그레이션 설정을 확인해 주세요.',
 COLLECTOR_INTERNAL_ERROR:'Worker가 수집기 제어 중 내부 오류를 반환했습니다. Cloudflare 로그의 collector_control_failed 항목을 확인해 주세요.'
};
export async function controlCollector(action:string,commandId:string){
 if(action!=='stop'&&action!=='status')requireLive();
 let identity;
 if(action==='start'||action==='reconnect'){
  const settings=await collectorSettings();
  if(!settings.alertUrl)throw new AppError('INVALID_INPUT','후원 알림 URL을 먼저 저장해 주세요.');
  try{identity=parseAlertBootstrap(await fetchPage(settings.alertUrl,'alert'))}
  catch{throw new AppError('PROVIDER_UNAVAILABLE','후원 알림 연결 정보를 읽지 못했습니다.',503)}
 }
 const origin=env('COLLECTOR_ORIGIN');let url:URL;
 try{url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password)throw Error()}
 catch{throw new AppError('COLLECTOR_CONFIG_INVALID','Vercel의 COLLECTOR_ORIGIN에 HTTPS Worker 주소를 설정해 주세요.',503)}
 const fail=(code:string,message:string,upstreamStatus?:number):never=>{
  // Never log request bodies, signatures, provider identifiers, or raw upstream responses.
  console.error(JSON.stringify({event:'collector_control_failed',code,action,commandId,upstreamStatus}));
  throw new AppError(code,message+(upstreamStatus?` (Worker HTTP ${upstreamStatus})`:''),503);
 };
 const body=JSON.stringify({commandId,action,...(identity?{identity}:{})});
 const headers=await signedHeaders(env('COLLECTOR_CONTROL_SECRET'),'/control',body);
 let response:Response;
 try{response=await fetch(url.origin+'/control',{method:'POST',redirect:'error',cache:'no-store',headers,body,signal:AbortSignal.timeout(12000)})}
 catch(error){
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))return fail('COLLECTOR_TIMEOUT','Worker 응답 시간이 초과되었습니다. 수집 상태를 먼저 확인해 주세요.');
  return fail('COLLECTOR_NETWORK_ERROR','Vercel에서 Worker에 연결하지 못했습니다. COLLECTOR_ORIGIN과 Worker 공개 접근 설정을 확인해 주세요.');
 }
 let payload:Record<string,unknown>|null=null;
 try{payload=record(await collectorResponse(response))}
 catch{if(response.ok)return fail('COLLECTOR_INVALID_RESPONSE','Worker가 올바른 수집기 응답을 반환하지 않았습니다. 배포된 Worker 코드를 확인해 주세요.',response.status)}
 if(!response.ok){
  if(response.status===401)return fail('COLLECTOR_AUTH_FAILED','Worker가 요청 서명 인증을 거부했습니다. 양쪽의 COLLECTOR_CONTROL_SECRET과 적용된 배포 버전을 확인해 주세요.',401);
  if(response.status===403)return fail('COLLECTOR_ACCESS_DENIED','Worker 접근이 거부되었습니다. Cloudflare Access와 보안 규칙을 확인해 주세요.',403);
  if(response.status===404)return fail('COLLECTOR_ROUTE_NOT_FOUND','Worker의 /control 경로를 찾지 못했습니다. COLLECTOR_ORIGIN과 배포된 Worker 코드를 확인해 주세요.',404);
  const code=record(payload?.error)?.code;
  if(typeof code==='string'&&Object.hasOwn(collectorErrorMessages,code))return fail(code,collectorErrorMessages[code],response.status);
  return fail('COLLECTOR_UPSTREAM_ERROR','Worker가 수집기 요청 처리에 실패했습니다. Cloudflare 로그를 확인해 주세요.',response.status);
 }
 if(!record(payload?.data))return fail('COLLECTOR_INVALID_RESPONSE','Worker 응답에 수집 상태가 없습니다. 배포된 Worker 코드를 확인해 주세요.',response.status);
 return payload!.data;
}
export async function integrationStatus(){
 const db=serviceDb();
 // The callback can fail independently of the command channel. Read the Worker
 // itself so missing DB reports never imply that collection has not started.
 const current=controlCollector('status',crypto.randomUUID()).then(data=>({state:{...record(data),observedAt:new Date().toISOString()},error:null})).catch(error=>({state:null,error:error instanceof AppError?error.message:'수집기의 현재 상태를 확인하지 못했습니다.'}));
 const [settings,catalog,mappings,saved,reviews,live]=await Promise.all([
  collectorSettings(),db.from('roulette_catalog').select('data,last_success_at').eq('id',true).maybeSingle(),
  db.from('roulette_mappings').select('*'),db.from('collector_state').select('*').eq('id',true).maybeSingle(),
  db.from('roulette_events').select('id',{count:'exact',head:true}).eq('status','review_required'),current
 ]);
 for(const result of [catalog,mappings,saved,reviews])dbError(result.error);
 return {settings,catalog:catalog.data?.data||null,lastCatalogAt:catalog.data?.last_success_at||null,mappings:mappings.data||[],
  state:live.state||(saved.data?{...saved.data.data,observedAt:saved.data.observed_at}:null),statusError:live.error,
  lastReportedAt:saved.data?.observed_at||null,reviewCount:reviews.count||0};
}
export async function ingestEvents(events:any[]){const db=serviceDb();const {data:catalog}=await db.from('roulette_catalog').select('data').eq('id',true).maybeSingle();const results=[];for(const e of events){const r=e.result;const clean={source:r.source,sourceEventId:r.sourceEventId,drawIndex:r.drawIndex,platform:r.platform,soop:r.soop,nickname:r.nickname,itemName:r.itemName,donation:r.donation,occurredAt:r.occurredAt};const sourceKey=r.sourceEventId&&r.drawIndex!==null?[env('STREAMER_KEY'),e.identityKey,r.platform,r.sourceEventId,r.drawIndex].join(':'):null;let status=r.status,reason=r.reason,mappingKey=null;if(status==='ready'){const matches=(catalog?.data?.groups||[]).flatMap((g:any)=>g.ranges.some((range:any)=>range.platform===r.platform&&r.donation>=range.min&&(range.max===null||r.donation<=range.max))?g.items.filter((i:any)=>i.name===r.itemName).map((i:any)=>g.id+':'+i.id):[]);if(matches.length===1)mappingKey=matches[0];else{status='review_required';reason=matches.length?'여러 룰렛에 같은 결과가 있습니다.':'연결할 룰렛 항목을 찾지 못했습니다.'}}try{results.push(await rpc(db,'ingest_result',{p_receipt:e.receiptId,p_source_key:sourceKey,p_payload:clean,p_mapping_key:mappingKey,p_status:status,p_reason:reason}))}catch{results.push({receiptId:e.receiptId,status:'retry'})}}return {results}}
