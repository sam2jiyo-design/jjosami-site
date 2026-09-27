const origin=process.argv[2];if(!origin)throw Error('Usage: node scripts/healthcheck.mjs https://your-domain');
const base=new URL(origin);if(!['https:','http:'].includes(base.protocol))throw Error('Invalid origin');
for(const path of ['/api/site','/api/songs','/api/signatures','/api/obligations','/api/auth/session']){const r=await fetch(new URL(path,base),{redirect:'error',signal:AbortSignal.timeout(15000)});const expected=path==='/api/auth/session'?401:200;if(r.status!==expected)throw Error(`${path}: expected ${expected}, received ${r.status}`);console.log(`${path}: ${r.status}`)}
console.log('Public reads and unauthenticated admin rejection passed.');
