import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePublicOrigin,requestOrigin,isSameOriginRequest,resolveRuntime,handleSession,isAuthenticated,handleRuntimeConfig} from '../lib/grading/server-runtime.mjs';
import {handleRuntimeAPI} from '../lib/grading/api-service.mjs';
import {DEFAULT_STAGE_PROFILES} from '../lib/grading/providers.mjs';
const env={GRADING_MODE:'managed',GRADING_PREPARE_API_KEY:'synthetic-prepare-key-for-origin',GRADING_API_KEY:'synthetic-grade-key-for-origin',GRADING_REVIEW_API_KEY:'synthetic-review-key-for-origin',GRADING_ACCESS_CODE:'synthetic-staff-code-for-origin',GRADING_SESSION_SECRET:'synthetic-session-secret-for-origin-at-least-32'};
const req=(path,body,headers={},method='POST')=>new Request('http://localhost:3027'+path,{method,headers:{'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});

test('public origin accepts only a bare HTTP(S) origin and invalid configuration fails closed',async()=>{
  assert.equal(normalizePublicOrigin(undefined),null);assert.equal(normalizePublicOrigin('https://grading.example.cn/'),'https://grading.example.cn');
  for(const value of ['https://user:secret@grading.example.cn','https://grading.example.cn/path','https://grading.example.cn/?secret=x','https://grading.example.cn/#fragment','file:///etc/passwd','not-a-url',' https://grading.example.cn']){
    assert.throws(()=>normalizePublicOrigin(value));const runtime=resolveRuntime({...env,GRADING_PUBLIC_ORIGIN:value});assert.equal(runtime.ready,false);
    const response=await handleRuntimeConfig(req('/api/runtime-config',undefined,{},'GET'),runtime);assert.ok(!JSON.stringify(await response.json()).includes(value));
  }
});
test('local Next localhost normalization uses the actual Host and ignores forwarded headers',async()=>{
  const headers={host:'127.0.0.1:3027',origin:'http://127.0.0.1:3027','x-forwarded-host':'attacker.example','x-forwarded-proto':'https'};
  const runtime=resolveRuntime(env),request=req('/api/session',{accessCode:env.GRADING_ACCESS_CODE},headers);
  assert.equal(requestOrigin(request,runtime),'http://127.0.0.1:3027');assert.equal(isSameOriginRequest(request,runtime),true);
  const response=await handleSession(request,runtime);assert.equal(response.status,200);
  const set=response.headers.get('set-cookie');assert.ok(!set.includes('Secure'));const cookie=set.split(';')[0];
  assert.equal(await isAuthenticated(req('/api/runtime-config',undefined,{...headers,cookie},'GET'),runtime),true);
  assert.equal(await isAuthenticated(req('/api/runtime-config',undefined,{...headers,host:'localhost:3027',cookie},'GET'),runtime),false);
  for(const origin of ['https://attacker.example','http://localhost:3027','null'])assert.equal((await handleSession(req('/api/session',undefined,{...headers,origin},'DELETE'),runtime)).status,403);
});
test('configured HTTPS proxy origin signs sessions and sets Secure using the public URL',async()=>{
  const runtime=resolveRuntime({...env,GRADING_PUBLIC_ORIGIN:'https://grading.example.cn'});
  const headers={host:'internal-service:3027',origin:'https://grading.example.cn','x-forwarded-host':'attacker.example','x-forwarded-proto':'http'};
  const response=await handleSession(req('/api/session',{accessCode:env.GRADING_ACCESS_CODE},headers),runtime);assert.equal(response.status,200);
  const set=response.headers.get('set-cookie');assert.match(set,/Secure/);assert.match(set,/HttpOnly/);const cookie=set.split(';')[0];
  assert.equal(await isAuthenticated(req('/api/runtime-config',undefined,{...headers,cookie},'GET'),runtime),true);
  assert.equal(await isAuthenticated(req('/api/runtime-config',undefined,{...headers,cookie},'GET'),{...runtime,publicOrigin:'https://other.example.cn'}),false);
  const logout=await handleSession(req('/api/session',undefined,headers,'DELETE'),runtime);assert.equal(logout.status,200);assert.match(logout.headers.get('set-cookie'),/Secure/);
  for(const origin of [undefined,'http://internal-service:3027','https://attacker.example','http://grading.example.cn']){
    const h={...headers};if(origin===undefined)delete h.origin;else h.origin=origin;
    assert.equal((await handleSession(req('/api/session',undefined,h,'DELETE'),runtime)).status,403);
  }
});
test('malformed or multiple Host values cannot establish a same-origin request',()=>{
  for(const host of ['evil.example/path','user@evil.example','evil.example,grading.example.cn','evil.example?x','evil.example#x','evil.example:99999']){
    assert.equal(requestOrigin(req('/api/session',undefined,{host,origin:'http://evil.example'})),null);
  }
});
test('paid API uses the same configured origin as login and refuses missing or cross-site Origin',async()=>{
  const runtime=resolveRuntime({...env,GRADING_PUBLIC_ORIGIN:'https://grading.example.cn'}),headers={host:'internal-service:3027',origin:'https://grading.example.cn'};
  const login=await handleSession(req('/api/session',{accessCode:env.GRADING_ACCESS_CODE},headers),runtime),cookie=login.headers.get('set-cookie').split(';')[0];
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]),sha256=Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
  const body={stageProfiles:structuredClone(DEFAULT_STAGE_PROFILES),requestId:'synthetic-proxy-request',page:{page_id:'P1',name:'synthetic.png',mime:'image/png',sha256,data:Buffer.from(bytes).toString('base64')}};
  let calls=0;const transport=async()=>{calls++;return new Response(JSON.stringify({id:'synthetic',status:'completed',usage:{input_tokens:10,output_tokens:10},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({name:null,student_id:'900001',name_status:'blank',student_id_status:'readable',warnings:[]})}]}]}));};
  const accepted=await handleRuntimeAPI(req('/api/identity',body,{...headers,cookie}),'identity',transport,runtime);assert.equal(accepted.status,200);assert.equal(calls,1);
  for(const origin of [undefined,'https://attacker.example']){
    const h={...headers,cookie,'x-forwarded-host':'attacker.example','x-forwarded-proto':'https'};if(origin===undefined)delete h.origin;else h.origin=origin;
    const rejected=await handleRuntimeAPI(req('/api/identity',body,h),'identity',transport,runtime);assert.equal(rejected.status,403);assert.equal((await rejected.json()).code,'ORIGIN');assert.equal(calls,1);
  }
});
