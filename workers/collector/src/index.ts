import {DurableObject} from 'cloudflare:workers';
import {signedHeaders,verifySignature} from '@jjosami/shared/security';
import {normalizeResults,packetEvent,type Identity,type RouletteResult} from '@jjosami/shared/roulette';
import {channels,subscription,donationDetails,eventKey,resultEnvelope,mergedResults,type Channel,type Donation} from './protocol';
export interface Env {ROULETTE_COLLECTOR:DurableObjectNamespace<RouletteCollector>;STREAMER_KEY:string;WEB_API_ORIGIN:string;COLLECTOR_INGEST_SECRET:string;COLLECTOR_CONTROL_SECRET:string;COLLECTOR_ENABLED:string;CATALOG_SYNC_INTERVAL_SECONDS:string}
type CollectorStatus={running:boolean;connection:string;channels:Record<Channel,string>;lastHeartbeatAt:string|null;lastDonationAt:string|null;lastEventAt:string|null;lastDbSuccessAt:string|null;pendingCount:number;pendingMatchCount:number;reconnects:number;lastError:string|null;lastCatalogError:string|null;lastReportError:string|null;gaps:{started:number;ended:number|null}[]};
type State={running:boolean;identity:Identity|null;connection:string;generation:number;retries:number;lastHeartbeatAt:number;lastDonationAt:number;lastEventAt:number;lastDbSuccessAt:number;nextConnectAt:number;lastCatalogAt:number;lastCatalogAttemptAt:number;lastCatalogError:string|null;lastReportError:string|null;lastError:string|null;gapFrom:number|null};
const initial:State={running:false,identity:null,connection:'stopped',generation:0,retries:0,lastHeartbeatAt:0,lastDonationAt:0,lastEventAt:0,lastDbSuccessAt:0,nextConnectAt:0,lastCatalogAt:0,lastCatalogAttemptAt:0,lastCatalogError:null,lastReportError:null,lastError:null,gapFrom:null};
type Link={socket:WebSocket|null;abort:AbortController;timer:ReturnType<typeof setTimeout>;ready:boolean;lastHeartbeatAt:number;connectDeadline:number;pingInterval:number;pingTimeout:number};
type PendingResult={id:string;payload:string;created:number};
const MATCH_WAIT_MS=15000,CONTEXT_TTL_MS=24*60*60*1000,QUEUE_LIMIT=20000;
class DeliveryError extends Error {
 constructor(public code:string,message:string,public status?:number){super(message)}
}
export class RouletteCollector extends DurableObject<Env>{
 private links=new Map<Channel,Link>();private flushing=false;
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, result TEXT NOT NULL, created INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER NOT NULL, ended INTEGER)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS donations (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS donations_created ON donations(created)');
  ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pending_results (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL)');
  ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS pending_results_created ON pending_results(created)');
  ctx.storage.sql.exec('INSERT OR IGNORE INTO metadata(id,data) VALUES(1,?)',JSON.stringify(initial));
  const s=this.state();if(s.running){const since=s.gapFrom||s.lastHeartbeatAt||Date.now();if(!s.gapFrom)ctx.storage.sql.exec('INSERT INTO gaps(started) VALUES(?)',since);this.update({gapFrom:since,connection:'connecting',generation:s.generation+1,nextConnectAt:Date.now()})}
 })}
 private state(){return {...initial,...JSON.parse(this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM metadata WHERE id=1').one().data)} as State}
 private update(patch:Partial<State>){const s={...this.state(),...patch};this.ctx.storage.sql.exec('UPDATE metadata SET data=? WHERE id=1',JSON.stringify(s));return s}
 private count(){return this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM outbox').one().n}
 private matchingCount(){return this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM pending_results').one().n}
 async control(command:{commandId:string;action:'start'|'stop'|'reconnect'|'status';identity?:Identity}):Promise<CollectorStatus>{
  if(command.action==='status')return this.status();const prior=this.ctx.storage.sql.exec<{result:string}>('SELECT result FROM commands WHERE id=?',command.commandId).toArray()[0];if(prior)return JSON.parse(prior.result);
  if(command.action!=='stop'&&this.env.COLLECTOR_ENABLED!=='true')throw Error('COLLECTOR_DISABLED');
  const s=this.state();if(command.action==='stop'){this.update({running:false,connection:'stopped',generation:s.generation+1,nextConnectAt:0});this.close();}
  else {const identity=command.identity||s.identity;if(!identity||identity.endpoint!=='https://ssmain.weflab.com'||!identity.idx||!identity.soop)throw Error('INVALID_IDENTITY');if(command.action==='reconnect'||!s.running||JSON.stringify(identity)!==JSON.stringify(s.identity)){this.update({running:true,identity,connection:'connecting',generation:s.generation+1,nextConnectAt:Date.now(),retries:0});this.close()}}
  const result=this.status();this.ctx.storage.sql.exec('INSERT INTO commands(id,result,created) VALUES(?,?,?)',command.commandId,JSON.stringify(result),Date.now());this.ctx.waitUntil(this.tick());return result;
 }
 status():CollectorStatus{const s=this.state();return {running:s.running,connection:s.connection,channels:Object.fromEntries(channels.map(c=>[c,this.links.get(c)?.ready?'connected':s.running?s.connection==='backoff'?'backoff':'connecting':'stopped'])) as Record<Channel,string>,lastHeartbeatAt:s.lastHeartbeatAt?new Date(s.lastHeartbeatAt).toISOString():null,lastDonationAt:s.lastDonationAt?new Date(s.lastDonationAt).toISOString():null,lastEventAt:s.lastEventAt?new Date(s.lastEventAt).toISOString():null,lastDbSuccessAt:s.lastDbSuccessAt?new Date(s.lastDbSuccessAt).toISOString():null,pendingCount:this.count(),pendingMatchCount:this.matchingCount(),reconnects:s.retries,lastError:s.lastError,lastCatalogError:s.lastCatalogError,lastReportError:s.lastReportError,gaps:this.ctx.storage.sql.exec<{started:number;ended:number|null}>('SELECT started,ended FROM gaps ORDER BY id DESC LIMIT 20').toArray()}}
 private close(){const old=[...this.links.values()];this.links.clear();for(const link of old){clearTimeout(link.timer);try{if(link.socket)link.socket.close(1000,'connection replaced');else link.abort.abort()}catch{}}}
 private failed(generation:number,message='연결이 끊겼습니다. 단절 구간의 결과를 대조해 주세요.'){
  const s=this.state();if(s.generation!==generation||!s.running)return;const retry=s.retries+1,next=Date.now()+Math.min(60000,1000*2**Math.min(retry,6))*(.75+Math.random()*.5);if(!s.gapFrom)this.ctx.storage.sql.exec('INSERT INTO gaps(started) VALUES(?)',Date.now());this.update({connection:'backoff',retries:retry,nextConnectAt:next,lastError:message,gapFrom:s.gapFrom||Date.now(),generation:generation+1});this.close();this.ctx.waitUntil(this.schedule())
 }
 private async openSocket(channel:Channel){
  if(this.links.has(channel)||!this.state().running)return;
  const s=this.state(),generation=s.generation,id=s.identity!,spec=subscription(channel,id),abort=new AbortController();
  const link:Link={socket:null,abort,timer:setTimeout(()=>abort.abort(),10000),ready:false,lastHeartbeatAt:Date.now(),connectDeadline:Date.now()+10000,pingInterval:25000,pingTimeout:20000};
  this.links.set(channel,link);this.update({connection:'connecting'});
  const current=()=>this.state().generation===generation&&this.state().running&&this.links.get(channel)===link;
  try{
   const response=await fetch(spec.url,{headers:{Upgrade:'websocket'},signal:abort.signal});
   // Leaving an AbortSignal timeout active after upgrade closes a healthy socket.
   clearTimeout(link.timer);
   const socket=response.webSocket;if(!socket||response.status!==101)throw Error('HANDSHAKE');
   socket.accept();if(!current()){socket.close();return}link.socket=socket;
   socket.addEventListener('message',event=>{
    if(!current()||typeof event.data!=='string')return;
    const raw=event.data;if(raw.length>65536){this.failed(generation,'허용 크기를 넘는 결과를 수신했습니다. 원본 대조가 필요합니다.');return}
    try{
     if(raw.startsWith('0')){
      const info=JSON.parse(raw.slice(1));
      if(!Number.isFinite(info.pingInterval)||!Number.isFinite(info.pingTimeout)||info.pingInterval<1000||info.pingInterval>120000||info.pingTimeout<1000||info.pingTimeout>120000)throw Error('PROTOCOL');
      link.pingInterval=info.pingInterval;link.pingTimeout=info.pingTimeout;link.lastHeartbeatAt=Date.now();socket.send('40');
     }else if(raw.startsWith('2')){
      socket.send('3'+raw.slice(1));link.lastHeartbeatAt=Date.now();this.update({lastHeartbeatAt:Date.now()});this.ctx.waitUntil(this.schedule());
     }else if(raw.startsWith('40')){
      if(link.ready)return;
      socket.send('42'+JSON.stringify(['msg',spec.join]));link.ready=true;link.lastHeartbeatAt=Date.now();
      if(channels.every(c=>this.links.get(c)?.ready)){
       this.update({connection:'connected',lastHeartbeatAt:Date.now(),lastError:null,nextConnectAt:0,gapFrom:null});
       this.ctx.storage.sql.exec('UPDATE gaps SET ended=? WHERE ended IS NULL',Date.now());this.ctx.waitUntil(this.report());
      }
      this.ctx.waitUntil(this.schedule());
     }else if(raw.startsWith('44')||raw==='1'||raw.startsWith('41')){
      this.failed(generation,'수신 채널이 연결을 종료했습니다. 다시 연결합니다.');
     }else{
      const message=packetEvent(raw);if(message)this.receive(channel,message,id);
     }
    }catch{this.failed(generation,'수신 메시지를 처리하지 못했습니다. 원본 결과를 대조해 주세요.')}
   });
   socket.addEventListener('close',()=>{if(current())this.failed(generation)});
   socket.addEventListener('error',()=>{if(current())this.failed(generation)});
  }catch{if(current())this.failed(generation,(channel==='results'?'룰렛 결과':'SOOP 후원')+' 서버에 연결하지 못했습니다. 잠시 후 다시 연결합니다.')}
  finally{clearTimeout(link.timer);await this.schedule()}
 }
 private donation(key:string){const row=this.ctx.storage.sql.exec<{payload:string}>('SELECT payload FROM donations WHERE id=? AND created>?',key,Date.now()-CONTEXT_TTL_MS).toArray()[0];return row?JSON.parse(row.payload) as Donation:null}
 private enqueue(results:RouletteResult[],identity:Identity){
  if(this.count()+results.length>QUEUE_LIMIT){this.update({running:false,connection:'degraded',lastError:'전송 대기열이 가득 찼습니다. 저장소를 확인해 주세요.'});this.close();return false}
  for(const result of results){const receiptId=crypto.randomUUID();this.ctx.storage.sql.exec('INSERT INTO outbox(id,payload,created) VALUES(?,?,?)',receiptId,JSON.stringify({receiptId,streamerKey:this.env.STREAMER_KEY,identityKey:identity.idx+':'+identity.preset,result}),Date.now())}
  return true;
 }
 private receive(channel:Channel,message:any,identity:Identity){
  if(channel==='donations'){
   const incoming=donationDetails(message,identity);if(!incoming)return;
   const key=eventKey(identity,incoming.uid),prior=this.donation(key);
   const conflict=prior&&(prior.id!==incoming.id||prior.name!==incoming.name||prior.value!==incoming.value);
   const donation=prior?{...prior,mode:conflict?'conflict':prior.mode,test:prior.test||incoming.test,replay:prior.replay||incoming.replay}:incoming;
   this.ctx.storage.sql.exec('DELETE FROM donations WHERE created<?',Date.now()-CONTEXT_TTL_MS);
   this.ctx.storage.sql.exec('INSERT INTO donations(id,payload,created) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',key,JSON.stringify(donation),Date.now());
   this.ctx.storage.sql.exec('DELETE FROM donations WHERE id IN (SELECT id FROM donations ORDER BY created DESC LIMIT -1 OFFSET 20000)');
   this.update({lastDonationAt:Date.now()});
   const waiting=this.ctx.storage.sql.exec<PendingResult>('SELECT id,payload,created FROM pending_results WHERE id=?',key).toArray()[0];
   if(waiting)this.resolvePending(waiting);
  }else{
   const results=normalizeResults(message,identity);if(!results.length)return;
   this.update({lastEventAt:Date.now()});
   const envelope=resultEnvelope(message),uid=results[0].sourceEventId,key=uid?eventKey(identity,uid):null,donation=key?this.donation(key):null;
   if(donation)this.enqueue(mergedResults(envelope,donation,identity),identity);
   else if(key&&results[0].platform==='afreeca'&&results[0].status!=='ignored'&&(!results[0].soop||!results[0].nickname||!results[0].donation)){
    if(this.matchingCount()>=QUEUE_LIMIT){this.update({running:false,connection:'degraded',lastError:'후원 정보 확인 대기열이 가득 찼습니다. 원본 결과를 대조해 주세요.'});this.close();return}
    // The two independent connections can deliver a result before its donation.
    const prior=this.ctx.storage.sql.exec<PendingResult>('SELECT id,payload,created FROM pending_results WHERE id=?',key).toArray()[0];
    if(prior&&JSON.stringify(JSON.parse(prior.payload).message)!==JSON.stringify(envelope)){
     const earlier=JSON.parse(prior.payload);earlier.message.data.mode='conflict';
     this.ctx.storage.sql.exec('UPDATE pending_results SET payload=? WHERE id=?',JSON.stringify(earlier),key);
     this.enqueue(results.map(r=>({...r,status:'review_required' as const,reason:'같은 후원 ID의 룰렛 결과가 달라 원본 확인이 필요합니다.'})),identity);
    }else this.ctx.storage.sql.exec('INSERT OR IGNORE INTO pending_results(id,payload,created) VALUES(?,?,?)',key,JSON.stringify({message:envelope,identity}),Date.now());
   }else this.enqueue(results,identity);
  }
  this.ctx.waitUntil(this.flush());this.ctx.waitUntil(this.schedule());
 }
 private resolvePending(row:PendingResult){
  const {message,identity}=JSON.parse(row.payload),donation=this.donation(row.id);
  if(!donation&&Date.now()<row.created+MATCH_WAIT_MS)return;
  const results=donation?mergedResults(message,donation,identity):normalizeResults(message,identity);
  if(this.enqueue(results,identity))this.ctx.storage.sql.exec('DELETE FROM pending_results WHERE id=?',row.id);
 }
 private async post(path:string,data:unknown){
  let origin:URL;
  try{origin=new URL(this.env.WEB_API_ORIGIN);if(origin.protocol!=='https:'||origin.username||origin.password)throw Error()}
  catch{throw new DeliveryError('WEB_ORIGIN_INVALID','Worker의 WEB_API_ORIGIN에 운영 웹사이트의 HTTPS 주소를 설정해 주세요.')}
  if(typeof this.env.COLLECTOR_INGEST_SECRET!=='string'||!this.env.COLLECTOR_INGEST_SECRET)throw new DeliveryError('INGEST_SECRET_MISSING','Worker의 COLLECTOR_INGEST_SECRET이 설정되지 않았습니다.');
  const body=JSON.stringify(data);let response:Response;
  // workerd rejects redirect: 'error' before any network request is made.
  // Inspect redirects explicitly and never forward the signed payload elsewhere.
  try{response=await fetch(origin.origin+path,{method:'POST',redirect:'manual',headers:await signedHeaders(this.env.COLLECTOR_INGEST_SECRET,path,body),body,signal:AbortSignal.timeout(15000)})}
  catch{throw new DeliveryError('WEB_NETWORK_ERROR','Worker에서 웹사이트에 연결하지 못했습니다. WEB_API_ORIGIN과 Vercel 접근 설정을 확인해 주세요.')}
  if(response.status>=300&&response.status<400){
   await response.body?.cancel().catch(()=>{});
   throw new DeliveryError('WEB_REDIRECT_REJECTED',`웹사이트가 다른 주소로 이동하도록 응답했습니다. WEB_API_ORIGIN에 리다이렉트 없는 운영 주소를 설정해 주세요. (Vercel HTTP ${response.status})`,response.status);
  }
  if(!response.ok){
   await response.body?.cancel().catch(()=>{});
   const message=response.status===401?'웹사이트가 수신 인증을 거부했습니다. 양쪽의 COLLECTOR_INGEST_SECRET과 Vercel Deployment Protection을 확인해 주세요.':response.status===403?'웹사이트 접근이 거부되었습니다. Vercel 접근 제한을 확인해 주세요.':response.status===404?'웹사이트의 수신 API를 찾지 못했습니다. Worker의 WEB_API_ORIGIN을 확인해 주세요.':'웹사이트의 수신 API가 요청 처리에 실패했습니다. Vercel 로그를 확인해 주세요.';
   throw new DeliveryError('WEB_HTTP_'+response.status,message+` (Vercel HTTP ${response.status})`,response.status);
  }
  const reader=response.body?.getReader();if(!reader)throw new DeliveryError('WEB_RESPONSE_INVALID','웹사이트가 비어 있는 응답을 반환했습니다.');
  const chunks:Uint8Array[]=[];let size=0;
  try{
   while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536)throw Error();chunks.push(part.value)}
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
   return JSON.parse(new TextDecoder().decode(bytes));
  }catch{throw new DeliveryError('WEB_RESPONSE_INVALID','웹사이트의 API 응답 형식이 올바르지 않습니다. WEB_API_ORIGIN과 Vercel 접근 설정을 확인해 주세요.')}
  finally{await reader.cancel().catch(()=>{})}
 }
 private async flush(){if(this.flushing)return;this.flushing=true;try{const rows=this.ctx.storage.sql.exec<{id:string;payload:string}>('SELECT id,payload FROM outbox ORDER BY created LIMIT 50').toArray();let bytes=0;const batch=[];for(const row of rows){if(bytes+new TextEncoder().encode(row.payload).length>240000)break;bytes+=new TextEncoder().encode(row.payload).length;batch.push(JSON.parse(row.payload))}if(!batch.length)return;const response=await this.post('/api/internal/weflab/events',{schemaVersion:1,events:batch});let acknowledged=0;for(const ack of response.data?.results||[]){if(batch.some(e=>e.receiptId===ack.receiptId)&&/^[a-f0-9-]{36}$/.test(ack.id||'')&&['applied','duplicate','review_required','ignored'].includes(ack.status)){this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?',ack.receiptId);acknowledged++}}if(acknowledged)this.update({lastDbSuccessAt:Date.now(),lastError:this.count()?this.state().lastError:null});else this.update({lastError:'저장 확인이 없어 같은 결과의 전송을 재시도합니다.'})}catch{this.update({lastError:'결과 전송을 재시도하고 있습니다. 수신한 결과는 대기열에 보존됩니다.'})}finally{this.flushing=false;await this.schedule()}}
 private async report(){
  try{
   const response=await this.post('/api/internal/weflab/state',{state:{...this.status(),lastReportError:null},observedAt:new Date().toISOString()});
   if(response?.data?.stored!==true)throw new DeliveryError('STATE_NOT_STORED','웹사이트에서 상태 저장을 확인하지 못했습니다.');
   this.update({lastReportError:null});
  }catch(error){
   const detail=error instanceof DeliveryError?error:new DeliveryError('STATE_REPORT_FAILED','웹사이트에 상태를 전달하지 못했습니다.');
   const message='상태 전달 실패: '+detail.message;
   if(this.state().lastReportError!==message)console.error(JSON.stringify({event:'collector_state_report_failed',code:detail.code,upstreamStatus:detail.status}));
   this.update({lastReportError:message});
  }
 }
 private async schedule(){
  const s=this.state(),queued=this.count(),waiting=this.matchingCount();
  if(!s.running&&!queued&&!waiting){await this.ctx.storage.deleteAlarm();return}
  const now=Date.now(),deadlines=[now+(queued?15000:60000)];
  if(s.running){
   if(!this.links.size)deadlines.push(s.nextConnectAt||now+1000);
   for(const link of this.links.values())deadlines.push(link.ready?link.lastHeartbeatAt+link.pingInterval+link.pingTimeout:link.connectDeadline);
  }
  if(waiting)deadlines.push(this.ctx.storage.sql.exec<{created:number}>('SELECT created FROM pending_results ORDER BY created LIMIT 1').one().created+MATCH_WAIT_MS);
  await this.ctx.storage.setAlarm(Math.max(now+1000,Math.min(...deadlines)));
 }
 async tick():Promise<void>{
  const s=this.state();
  if(s.running&&this.env.COLLECTOR_ENABLED!=='true'){
   this.update({running:false,connection:'stopped',generation:s.generation+1});this.close();
  }else if(s.running){
   if([...this.links.values()].some(link=>Date.now()>(link.ready?link.lastHeartbeatAt+link.pingInterval+link.pingTimeout:link.connectDeadline)))this.failed(s.generation,'수신 채널의 응답이 지연되어 다시 연결합니다.');
   if(Date.now()>=this.state().nextConnectAt)await Promise.all(channels.map(channel=>this.openSocket(channel)));
   if(Date.now()-s.lastCatalogAt>Number(this.env.CATALOG_SYNC_INTERVAL_SECONDS||1800)*1000&&Date.now()-s.lastCatalogAttemptAt>60000){
    this.update({lastCatalogAttemptAt:Date.now()});
    try{await this.post('/api/internal/weflab/catalog/sync',{});this.update({lastCatalogAt:Date.now(),lastCatalogError:null})}
    catch{this.update({lastCatalogError:'룰렛 목록을 갱신하지 못했습니다. 마지막 정상 목록을 사용합니다.'})}
   }
  }
  for(const row of this.ctx.storage.sql.exec<PendingResult>('SELECT id,payload,created FROM pending_results ORDER BY created LIMIT 50').toArray())this.resolvePending(row);
  await this.flush();await this.report();await this.schedule();
 }
 async alarm():Promise<void>{await this.tick()}
}
export default {
 async fetch(request:Request,env:Env):Promise<Response>{
  const url=new URL(request.url);
  if(url.pathname!=='/control'||request.method!=='POST')return new Response('Not found',{status:404});
  if(Number(request.headers.get('content-length'))>8192)return new Response('Too large',{status:413});
  const reader=request.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
  if(reader){try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>8192)return new Response('Too large',{status:413});chunks.push(r.value)}}finally{await reader.cancel().catch(()=>{})}}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length}
  const body=new TextDecoder().decode(bytes);
  if(!await verifySignature(env.COLLECTOR_CONTROL_SECRET,request.headers,request.method,url.pathname,body))return Response.json({error:{code:'COLLECTOR_AUTH_FAILED'}},{status:401});
  let command:Parameters<RouletteCollector['control']>[0];
  try{
   const input=JSON.parse(body);
   if(!input||typeof input.commandId!=='string'||!/^[a-f0-9-]{36}$/.test(input.commandId)||!['start','stop','reconnect','status'].includes(input.action))throw Error();
   command=input;
  }catch{return Response.json({error:{code:'COLLECTOR_INVALID_COMMAND'}},{status:400})}
  let stage='configuration';
  const fail=(code:string,errorType='Error')=>{
   // Fixed diagnostic fields only: private alert identities and secrets must never enter logs.
   console.error(JSON.stringify({event:'collector_control_failed',code,stage,action:command.action,commandId:command.commandId,errorType}));
   return Response.json({error:{code}},{status:503});
  };
  if(!env.ROULETTE_COLLECTOR||typeof env.ROULETTE_COLLECTOR.getByName!=='function')return fail('COLLECTOR_BINDING_MISSING');
  if(typeof env.STREAMER_KEY!=='string'||!env.STREAMER_KEY.trim())return fail('COLLECTOR_STREAMER_KEY_MISSING');
  try{
   stage='durable-object-lookup';
   const collector=env.ROULETTE_COLLECTOR.getByName(env.STREAMER_KEY);
   stage='durable-object-control';
   return Response.json({data:await collector.control(command)});
  }catch(error){
   const message=error instanceof Error?error.message:'';
   const code=message==='COLLECTOR_DISABLED'?'COLLECTOR_DISABLED':message==='INVALID_IDENTITY'?'COLLECTOR_INVALID_IDENTITY':/SQL is not enabled|SQLITE_ERROR|no such table|has no SQL storage/i.test(message)?'COLLECTOR_STORAGE_UNAVAILABLE':'COLLECTOR_INTERNAL_ERROR';
   const errorType=error instanceof TypeError?'TypeError':error instanceof SyntaxError?'SyntaxError':'Error';
   return fail(code,errorType);
  }
 },
 async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext){ctx.waitUntil(env.ROULETTE_COLLECTOR.getByName(env.STREAMER_KEY).tick())}
} satisfies ExportedHandler<Env>;
