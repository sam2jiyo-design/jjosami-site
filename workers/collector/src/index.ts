import {DurableObject} from 'cloudflare:workers';
import {signedHeaders,verifySignature} from '@jjosami/shared/security';
import {normalizeResults,packetEvent,type Identity} from '@jjosami/shared/roulette';
export interface Env {ROULETTE_COLLECTOR:DurableObjectNamespace<RouletteCollector>;STREAMER_KEY:string;WEB_API_ORIGIN:string;COLLECTOR_INGEST_SECRET:string;COLLECTOR_CONTROL_SECRET:string;COLLECTOR_ENABLED:string;CATALOG_SYNC_INTERVAL_SECONDS:string}
type CollectorStatus={running:boolean;connection:string;lastHeartbeatAt:string|null;lastEventAt:string|null;lastDbSuccessAt:string|null;pendingCount:number;reconnects:number;lastError:string|null;lastCatalogError:string|null;gaps:{started:number;ended:number|null}[]};
type State={running:boolean;identity:Identity|null;connection:string;generation:number;retries:number;lastHeartbeatAt:number;lastEventAt:number;lastDbSuccessAt:number;nextConnectAt:number;lastCatalogAt:number;lastCatalogAttemptAt:number;lastCatalogError:string|null;lastError:string|null;gapFrom:number|null;pingInterval:number;pingTimeout:number};
const initial:State={running:false,identity:null,connection:'stopped',generation:0,retries:0,lastHeartbeatAt:0,lastEventAt:0,lastDbSuccessAt:0,nextConnectAt:0,lastCatalogAt:0,lastCatalogAttemptAt:0,lastCatalogError:null,lastError:null,gapFrom:null,pingInterval:25000,pingTimeout:20000};
export class RouletteCollector extends DurableObject<Env>{
 private socket:WebSocket|null=null;private opening=false;private flushing=false;
 constructor(ctx:DurableObjectState,env:Env){super(ctx,env);ctx.blockConcurrencyWhile(async()=>{ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY, data TEXT NOT NULL)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created INTEGER NOT NULL)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, result TEXT NOT NULL, created INTEGER NOT NULL)');ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS gaps (id INTEGER PRIMARY KEY AUTOINCREMENT, started INTEGER NOT NULL, ended INTEGER)');ctx.storage.sql.exec('INSERT OR IGNORE INTO metadata(id,data) VALUES(1,?)',JSON.stringify(initial));const s=this.state();if(s.running&&!s.gapFrom){const since=s.lastHeartbeatAt||Date.now();ctx.storage.sql.exec('INSERT INTO gaps(started) VALUES(?)',since);this.update({gapFrom:since,connection:'connecting',generation:s.generation+1,nextConnectAt:Date.now()})}})}
 private state(){return {...initial,...JSON.parse(this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM metadata WHERE id=1').one().data)} as State}
 private update(patch:Partial<State>){const s={...this.state(),...patch};this.ctx.storage.sql.exec('UPDATE metadata SET data=? WHERE id=1',JSON.stringify(s));return s}
 private count(){return this.ctx.storage.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM outbox').one().n}
 async control(command:{commandId:string;action:'start'|'stop'|'reconnect'|'status';identity?:Identity}):Promise<CollectorStatus>{
  if(command.action==='status')return this.status();const prior=this.ctx.storage.sql.exec<{result:string}>('SELECT result FROM commands WHERE id=?',command.commandId).toArray()[0];if(prior)return JSON.parse(prior.result);
  if(command.action!=='stop'&&this.env.COLLECTOR_ENABLED!=='true')throw Error('COLLECTOR_DISABLED');
  const s=this.state();if(command.action==='stop'){this.update({running:false,connection:'stopped',generation:s.generation+1,nextConnectAt:0});this.close();}
  else {const identity=command.identity||s.identity;if(!identity||identity.endpoint!=='https://ssmain.weflab.com'||!identity.idx||!identity.soop)throw Error('INVALID_IDENTITY');if(command.action==='reconnect'||!s.running||JSON.stringify(identity)!==JSON.stringify(s.identity)){this.update({running:true,identity,connection:'connecting',generation:s.generation+1,nextConnectAt:Date.now(),retries:0});this.close()}}
  const result=this.status();this.ctx.storage.sql.exec('INSERT INTO commands(id,result,created) VALUES(?,?,?)',command.commandId,JSON.stringify(result),Date.now());this.ctx.waitUntil(this.tick());return result;
 }
 status():CollectorStatus{const s=this.state();return {running:s.running,connection:s.connection,lastHeartbeatAt:s.lastHeartbeatAt?new Date(s.lastHeartbeatAt).toISOString():null,lastEventAt:s.lastEventAt?new Date(s.lastEventAt).toISOString():null,lastDbSuccessAt:s.lastDbSuccessAt?new Date(s.lastDbSuccessAt).toISOString():null,pendingCount:this.count(),reconnects:s.retries,lastError:s.lastError,lastCatalogError:s.lastCatalogError,gaps:this.ctx.storage.sql.exec<{started:number;ended:number|null}>('SELECT started,ended FROM gaps ORDER BY id DESC LIMIT 20').toArray()}}
 private close(){const old=this.socket;this.socket=null;this.opening=false;try{old?.close(1000,'connection replaced')}catch{}}
 private failed(generation:number,message='연결이 끊겼습니다. 단절 구간의 결과를 대조해 주세요.'){
  const s=this.state();if(s.generation!==generation||!s.running)return;const retry=s.retries+1,next=Date.now()+Math.min(60000,1000*2**Math.min(retry,6))*(.75+Math.random()*.5);if(!s.gapFrom)this.ctx.storage.sql.exec('INSERT INTO gaps(started) VALUES(?)',Date.now());this.update({connection:'backoff',retries:retry,nextConnectAt:next,lastError:message,gapFrom:s.gapFrom||Date.now(),generation:generation+1});this.close();this.ctx.waitUntil(this.schedule())
 }
 private async openSocket(){if(this.opening||this.socket||!this.state().running)return;const s=this.state(),generation=s.generation;this.opening=true;this.update({connection:'connecting',lastHeartbeatAt:Date.now()});try{
   const id=s.identity!;const url='https://ssmain.weflab.com/socket.io/?'+new URLSearchParams({EIO:'4',transport:'websocket',idx:id.idx,type:'page',page:'alert'});const response=await fetch(url,{headers:{Upgrade:'websocket'},signal:AbortSignal.timeout(10000)});const socket=response.webSocket;if(!socket||response.status!==101)throw Error('HANDSHAKE');if(this.state().generation!==generation||!this.state().running){socket.accept();socket.close();return}this.socket=socket;socket.accept();
   socket.addEventListener('message',event=>{if(this.state().generation!==generation||this.socket!==socket||typeof event.data!=='string')return;const raw=event.data;if(raw.length>65536){this.failed(generation,'허용 크기를 넘는 결과를 수신했습니다. 원본 대조가 필요합니다.');return}
    if(raw.startsWith('0')){try{const info=JSON.parse(raw.slice(1));if(!Number.isFinite(info.pingInterval)||!Number.isFinite(info.pingTimeout)||info.pingInterval<1000||info.pingInterval>120000||info.pingTimeout<1000||info.pingTimeout>120000)throw Error();this.update({pingInterval:info.pingInterval,pingTimeout:info.pingTimeout,lastHeartbeatAt:Date.now()});socket.send('40')}catch{this.failed(generation,'소켓 연결 형식이 변경되었습니다.')}}
    else if(raw==='2'||raw.startsWith('2')){socket.send('3'+raw.slice(1));this.update({lastHeartbeatAt:Date.now()});this.ctx.waitUntil(this.schedule())}
    else if(raw.startsWith('40')){socket.send('42'+JSON.stringify(['msg',{type:'join',page:'page',idx:id.idx,pageid:'alert',preset:id.preset}]));this.update({connection:'connected',lastHeartbeatAt:Date.now(),lastError:null,nextConnectAt:0});if(s.gapFrom)this.ctx.storage.sql.exec('UPDATE gaps SET ended=? WHERE ended IS NULL',Date.now());this.update({gapFrom:null});this.ctx.waitUntil(this.report())}
    else if(raw.startsWith('44'))this.failed(generation,'결과 서버가 연결을 거부했습니다. 설정을 확인해 주세요.');
    else {const event=packetEvent(raw);if(event){const results=normalizeResults(event,id);for(const result of results){if(this.count()>=20000){this.update({connection:'degraded',lastError:'전송 대기열이 가득 찼습니다. 수집을 중지하고 저장소를 확인해 주세요.',running:false});this.close();break}const receiptId=crypto.randomUUID();this.ctx.storage.sql.exec('INSERT INTO outbox(id,payload,created) VALUES(?,?,?)',receiptId,JSON.stringify({receiptId,streamerKey:this.env.STREAMER_KEY,identityKey:id.idx+':'+id.preset,result}),Date.now());this.update({lastEventAt:Date.now()})}if(results.length)this.ctx.waitUntil(this.flush())}}
   });socket.addEventListener('close',()=>{if(this.socket===socket)this.failed(generation)});socket.addEventListener('error',()=>{if(this.socket===socket)this.failed(generation)});
  }catch{this.failed(generation,'결과 서버에 연결하지 못했습니다. 잠시 후 다시 연결합니다.')}finally{this.opening=false;await this.schedule()}
 }
 private async post(path:string,data:unknown){const origin=new URL(this.env.WEB_API_ORIGIN);if(origin.protocol!=='https:')throw Error('INVALID_ORIGIN');const body=JSON.stringify(data);const response=await fetch(origin.origin+path,{method:'POST',redirect:'error',headers:await signedHeaders(this.env.COLLECTOR_INGEST_SECRET,path,body),body,signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('API_UNAVAILABLE');return response.json() as Promise<any>}
 private async flush(){if(this.flushing)return;this.flushing=true;try{const rows=this.ctx.storage.sql.exec<{id:string;payload:string}>('SELECT id,payload FROM outbox ORDER BY created LIMIT 50').toArray();let bytes=0;const batch=[];for(const row of rows){if(bytes+new TextEncoder().encode(row.payload).length>240000)break;bytes+=new TextEncoder().encode(row.payload).length;batch.push(JSON.parse(row.payload))}if(!batch.length)return;const response=await this.post('/api/internal/weflab/events',{schemaVersion:1,events:batch});let acknowledged=0;for(const ack of response.data?.results||[]){if(batch.some(e=>e.receiptId===ack.receiptId)&&/^[a-f0-9-]{36}$/.test(ack.id||'')&&['applied','duplicate','review_required','ignored'].includes(ack.status)){this.ctx.storage.sql.exec('DELETE FROM outbox WHERE id=?',ack.receiptId);acknowledged++}}if(acknowledged)this.update({lastDbSuccessAt:Date.now(),lastError:this.count()?this.state().lastError:null});else this.update({lastError:'저장 확인이 없어 같은 결과의 전송을 재시도합니다.'})}catch{this.update({lastError:'결과 전송을 재시도하고 있습니다. 수신한 결과는 대기열에 보존됩니다.'})}finally{this.flushing=false;await this.schedule()}}
 private async report(){try{await this.post('/api/internal/weflab/state',{state:this.status(),observedAt:new Date().toISOString()})}catch{} }
 private async schedule(){const s=this.state();if(!s.running&&!this.count()){await this.ctx.storage.deleteAlarm();return}const now=Date.now();const due=s.running&&this.socket?s.lastHeartbeatAt+s.pingInterval+s.pingTimeout:s.running?s.nextConnectAt||now+1000:now+30000;await this.ctx.storage.setAlarm(Math.max(now+1000,Math.min(due,now+(this.count()?15000:60000))))}
 async tick():Promise<void>{const s=this.state();if(s.running&&this.env.COLLECTOR_ENABLED!=='true'){this.update({running:false,connection:'stopped',generation:s.generation+1});this.close()}else if(s.running){if(this.socket&&Date.now()-s.lastHeartbeatAt>s.pingInterval+s.pingTimeout)this.failed(s.generation,'서버 응답이 지연되어 다시 연결합니다.');if(!this.socket&&!this.opening&&Date.now()>=this.state().nextConnectAt)await this.openSocket();if(Date.now()-s.lastCatalogAt>Number(this.env.CATALOG_SYNC_INTERVAL_SECONDS||1800)*1000&&Date.now()-s.lastCatalogAttemptAt>60000){this.update({lastCatalogAttemptAt:Date.now()});try{await this.post('/api/internal/weflab/catalog/sync',{});this.update({lastCatalogAt:Date.now(),lastCatalogError:null})}catch{this.update({lastCatalogError:'룰렛 목록을 갱신하지 못했습니다. 마지막 정상 목록을 사용합니다.'})}}}await this.flush();await this.report();await this.schedule()}
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
