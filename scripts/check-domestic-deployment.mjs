import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// Read-only readiness check: never sends grading requests or API keys.
const root=fileURLToPath(new URL('../',import.meta.url));
const {version}=JSON.parse(await readFile(path.join(root,'node_modules/pdfjs-dist/package.json'),'utf8'));
const asset=`/pdfjs/${version}/pdf.worker.min.mjs`;
for(const item of ['server.js','public'+asset,'.next/static'])await access(path.join(root,'.next/standalone',item));
const base=new URL(process.argv[2]||`http://127.0.0.1:${process.env.PORT||3000}`);
assert(['http:','https:'].includes(base.protocol),'Only HTTP(S) deployment URLs are supported.');
for(const route of ['/','/api/runtime-config',asset]){
  const response=await fetch(new URL(route,base),{signal:AbortSignal.timeout(15000),redirect:'error'});
  assert.equal(response.status,200,`${route} returned ${response.status}`);
  if(route==='/api/runtime-config'){
    const config=await response.json();
    assert(config&&typeof config==='object','Runtime config is not an object');
    assert.equal(config.ready,true,config.message||'Runtime is not ready');
    assert(Object.values(config.stageProfiles||{}).length===3,'Expected three stage profiles');
    for(const stage of Object.values(config.stageProfiles))assert(['kimi','deepseek','qwen'].includes(stage.provider),'Unexpected provider');
    assert(!JSON.stringify(config).includes('api.openai.com'),'Unexpected GPT endpoint');
    console.log('Runtime config responds without sending a paid request.');
  } else if(route===asset)assert((await response.text()).length>10000,'PDF worker is incomplete');
  else await response.arrayBuffer();
  console.log(`OK ${route}`);
}
// A fresh request carries no cookie: this only verifies the site's Origin guard.
// The returned expired cookie is not saved, so no staff browser session is changed.
const originCheck=await fetch(new URL('/api/session',base),{
  method:'DELETE',headers:{origin:base.origin},signal:AbortSignal.timeout(15000),redirect:'error',
});
assert.equal(originCheck.status,200,'Same-origin session request was rejected; check the public origin and reverse proxy configuration.');
assert.equal((await originCheck.json()).authenticated,false);
console.log('OK same-origin request guard (no existing session or paid request)');
console.log('Ready: homepage, runtime config, same-origin request guard and local PDF worker.');
