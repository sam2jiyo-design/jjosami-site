import {load} from 'cheerio';
import {createHash} from 'node:crypto';

export const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=value=>typeof value==='string'?value.trim():'';
const labels={afreeca:'SOOP',naver:'치지직',youtube:'유튜브',twitch:'트위치',cime:'씨미',soopg:'SOOP G',flextv:'플렉스TV'};
export function validateUrl(value,kind){
 let url;try{url=new URL(value)}catch{throw Error('위플랩 URL을 입력해 주세요.')}
 if(url.protocol!=='https:'||url.hostname!=='weflab.com'||url.port||url.username||url.password||url.search||url.hash||!new RegExp(`^/${kind==='catalog'?'user':'page'}/[A-Za-z0-9_-]+/?$`).test(url.pathname))throw Error(kind==='catalog'?'위플랩의 /user/ 룰렛 목록 URL을 입력해 주세요.':'위플랩의 /page/ 후원 알림 URL을 입력해 주세요.');
 return url.href.replace(/\/$/,'');
}
export async function fetchPage(url,kind,fetcher=fetch){
 const target=validateUrl(url,kind),response=await fetcher(target,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'text/html','User-Agent':'JjosamiIntegration/0.1 (catalog and configured alert bootstrap)'}});
 if(!response.ok)throw Error(`위플랩 페이지를 불러오지 못했습니다. (HTTP ${response.status})`);
 if(!response.headers.get('content-type')?.includes('text/html'))throw Error('위플랩 페이지 응답 형식이 변경되었습니다.');
 const reader=response.body.getReader();let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000)throw Error('위플랩 응답이 허용 크기를 초과했습니다.');chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
 return Buffer.concat(chunks).toString('utf8');
}
export function parseCatalog(html){
 const $=load(html),root=$('.user_page_area.roulette_area');
 if(root.length!==1)throw Error('공개 룰렛 목록을 찾지 못했습니다. URL 또는 공개 설정을 확인해 주세요.');
 const boxes=root.find('.setup_alert_list .alert_box').toArray();
 if(!boxes.length)throw Error('공개된 룰렛이 없거나 목록 구조가 변경되었습니다.');
 const groups=boxes.map((box,index)=>{
  const el=$(box),ranges=el.find('.count.platform_area').toArray().map(node=>{
   const row=$(node),platform=(row.attr('class')||'').split(/\s+/).find(c=>/^platform_(?!area$)/.test(c))?.slice(9);
   const min=Number(row.find('.value.min').text().replaceAll(',','')),rawMax=row.find('.value.max').text().replaceAll(',',''),max=rawMax?Number(rawMax):null;
   if(!platform||!Number.isFinite(min)||min<0||(max!==null&&(!Number.isFinite(max)||max<min)))throw Error('룰렛 후원 범위를 해석하지 못했습니다.');
   return {platform,min,max};
  });
  const items=el.find('.roulette_list .roulette_box').toArray().map(node=>{
   const row=$(node),name=text(row.find('.input_roulette_name').val()),type=text(row.find('.select_roulette_type').val()),percent=Number(row.find('.input_roulette_percent').val());
   if(!name||name.length>200||!type||!Number.isFinite(percent)||percent<0)throw Error('룰렛 항목을 해석하지 못했습니다. 기존 목록은 유지됩니다.');
   return {name,type,percent};
  });
  if(!ranges.length||!items.length||items.length>500||new Set(items.map(x=>x.name)).size!==items.length)throw Error('룰렛 항목 또는 범위를 고유하게 식별할 수 없습니다.');
  const id=fingerprint({ranges:[...ranges].sort((a,b)=>a.platform.localeCompare(b.platform)),items:items.map(x=>[x.name,x.type]).sort()}).slice(0,24);
  const r=ranges.find(x=>x.platform==='afreeca')||ranges[0],range=r.max===null?`${r.min.toLocaleString('ko-KR')} 이상`:`${r.min.toLocaleString('ko-KR')}–${r.max.toLocaleString('ko-KR')}`;
  return {id,name:`${labels[r.platform]||r.platform} ${range} 룰렛`,position:index,ranges,items:items.map(x=>({...x,id:fingerprint([id,x.name,x.type]).slice(0,24)}))};
 });
 if(new Set(groups.map(g=>g.id)).size!==groups.length)throw Error('같은 구성의 룰렛이 여러 개여서 구분할 수 없습니다.');
 return {groups,version:fingerprint(groups),fetchedAt:new Date().toISOString()};
}
function jsonAssignment(source,name){
 const match=new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`).exec(source);if(!match)throw Error('후원 알림의 연결 정보를 찾지 못했습니다.');
 const start=match.index+match[0].length;if(source[start]!=='{')throw Error('연결 정보 형식이 변경되었습니다.');
 let depth=0,quoted=false,escaped=false;
 for(let i=start;i<source.length;i++){const ch=source[i];if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue}if(ch==='"')quoted=true;else if(ch==='{')depth++;else if(ch==='}'&&--depth===0)return JSON.parse(source.slice(start,i+1))}
 throw Error('연결 정보를 끝까지 읽지 못했습니다.');
}
export function parseAlertBootstrap(html){
 const data=jsonAssignment(html,'loginData');
 if(data.result!==true||data.type!=='page'||data.pageid!=='alert'||!text(String(data.idx||''))||!text(data.platform?.afreeca?.id))throw Error('SOOP 계정이 연결된 후원 알림 페이지인지 확인해 주세요.');
 const endpoint=new URL(data.config?.url?.socket||'');
 if(endpoint.href!=='https://ssmain.weflab.com/')throw Error('지원되는 위플랩 결과 서버가 아닙니다.');
 // Do not retain the user profile, email, provider credentials, or the raw HTML.
 return {idx:String(data.idx),preset:String(data.preset??'0'),soop:data.platform.afreeca.id,endpoint:endpoint.origin};
}
