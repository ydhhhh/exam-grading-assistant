import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBrowserAPIFetch} from '../lib/grading/browser-api.mjs';
import {DEFAULT_STAGE_PROFILES,PROVIDERS,getDefaultProfile} from '../lib/grading/providers.mjs';
import {reviewResultHash} from '../lib/grading/review-profile.mjs';

const ORIGIN='https://ydhhhh.github.io';
const KEYS={prepare:'synthetic-personal-prepare-key',grade:'synthetic-personal-grade-key',review:'synthetic-personal-review-key'};
const pack=()=>({exam_id:'SYNTHETIC',title:'Synthetic only',version:'1',demo:false,approved_by:'Synthetic teacher',policies:'Synthetic fixture.',questions:[{question_id:'Q1',text:'Synthetic question',solution:'Synthetic answer',max_score:5,criteria:[{criterion_id:'C1',description:'Synthetic criterion',allowed_scores:[0,1,2,3,4,5],requires:[]}]}]});
const result=()=>({question_id:'Q1',status:'scored',criteria:[{criterion_id:'C1',awarded:5,evidence_refs:['P1'],reason:'Observed synthetic evidence'}],flags:[],alternative_solution:false});
const identity=()=>({name:'合成测试甲',student_id:'900000001',name_status:'readable',student_id_status:'readable',warnings:[]});
const stageFor=action=>action==='identity'?'grade':action;
function profiles(action,provider){
  const value=structuredClone(DEFAULT_STAGE_PROFILES),stage=stageFor(action);
  value[stage]=getDefaultProfile(provider,stage);
  if(value.grade.model===value.review.model){const other=stage==='review'?'grade':'review';value[other]=getDefaultProfile(provider==='deepseek'?'kimi':'deepseek',other);}
  return value;
}
async function file(){
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {name:'private-test-file.png',mime:'image/png',data:btoa(String.fromCharCode(...bytes)),sha256};
}
async function body(action,provider='deepseek'){
  const common={requestId:`synthetic-${action}-${provider}`,stageProfiles:profiles(action,provider)},image=await file();
  if(action==='prepare')return {...common,documents:['paper','solution','rubric'].map(role=>({role,sourceMime:image.mime,sourceSha256:image.sha256,files:[image]}))};
  if(action==='identity')return {...common,page:{page_id:'P1',...image}};
  const value={...common,pack:pack(),questionId:'Q1',pages:[{page_id:'P1',...image}]};
  if(action==='review'){
    value.initialResult=result();value.initialResult.criteria[0].reason='INITIAL_ONLY_PRIVATE_REASON';
    value.initialResultHash=await reviewResultHash(value.initialResult);value.reviewProfile=common.stageProfiles.review;
  }
  return value;
}
function options(action,data,extra={}){return {method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Api-Key':KEYS[stageFor(action)],'X-Api-Provider':data.stageProfiles[stageFor(action)].provider},body:JSON.stringify(data),...extra};}
function output(action){if(action==='identity')return identity();if(action==='prepare')return {pack:{...pack(),approved_by:''},warnings:[]};return result();}
function response(provider,action,value=output(action),extra={}){
  const content=JSON.stringify(value),base={id:'synthetic-response',model:PROVIDERS[provider].model};
  const envelope=provider==='deepseek'?{...base,status:'completed',usage:{input_tokens:1000,output_tokens:200},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:content}]}]}:{...base,usage:{prompt_tokens:1000,completion_tokens:200},choices:[{finish_reason:'stop',message:{role:'assistant',content}}]};
  return new Response(JSON.stringify({...envelope,...extra}),{headers:{'content-type':'application/json'}});
}

for(const provider of ['kimi','deepseek','qwen'])for(const action of ['prepare','identity','grade','review'])test(`static ${provider} ${action} validates and sends one official request with only its stage key`,async()=>{
  const calls=[],data=await body(action,provider);
  const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async(url,init)=>{calls.push({url,init});return response(provider,action);}});
  const reply=await fetcher('/api/'+action,options(action,data)),out=await reply.json();
  assert.equal(reply.status,200,JSON.stringify(out));assert.equal(calls.length,1);
  const {url,init}=calls[0];assert.equal(url,PROVIDERS[provider].endpoint);
  assert.equal(init.method,'POST');assert.equal(init.mode,'cors');assert.equal(init.credentials,'omit');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.equal(init.referrerPolicy,'no-referrer');
  assert.deepEqual(Object.keys(init.headers).sort(),['authorization','content-type']);
  assert.equal(init.headers.authorization,'Bearer '+KEYS[stageFor(action)]);
  for(const secret of Object.values(KEYS)){assert.ok(!init.body.includes(secret));assert.ok(!JSON.stringify(out).includes(secret));}
  assert.ok(!init.body.includes('private-test-file'));assert.ok(!init.body.includes('INITIAL_ONLY_PRIVATE_REASON'));
  assert.equal(out.requestId,data.requestId);assert.deepEqual(out.stageProfiles,data.stageProfiles);assert.deepEqual(out.stageProfile,data.stageProfiles[stageFor(action)]);assert.equal(out.provider,provider);
  assert.equal(out.model,PROVIDERS[provider].model);assert.ok(out.estimatedCny>0);
  if(action==='review'){assert.equal(out.initialResultHash,data.initialResultHash);assert.deepEqual(out.reviewProfile,data.reviewProfile);}
});

test('browser Request guards may remove Origin without defeating in-memory same-origin validation',async()=>{
  const NativeRequest=globalThis.Request;let stripped=false,calls=0;
  globalThis.Request=class extends NativeRequest{constructor(...args){super(...args);if(this.headers.has('origin')){this.headers.delete('origin');stripped=true;}}};
  try{
    const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async()=>{calls++;return response('deepseek','grade');}}),data=await body('grade');
    const reply=await fetcher('/api/grade',options('grade',data)),out=await reply.json();assert.equal(stripped,true);assert.equal(reply.status,200,JSON.stringify(out));assert.equal(calls,1);assert.ok(out.result);
  }finally{globalThis.Request=NativeRequest;}
});

test('static transport rejects local session/config routes and arbitrary URLs without networking',async()=>{
  let calls=0;const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:()=>{calls++;}}),data=await body('grade');
  for(const path of ['/api/runtime-config','/api/session','/api/unknown','https://evil.example/api/grade',ORIGIN+'/api/grade','/api/grade?url=evil','/api/grade/','/api/grade#fragment']){
    const reply=await fetcher(path,options('grade',data));assert.equal(reply.status,404);assert.equal((await reply.json()).notSent,true);
  }
  assert.equal(calls,0);
});

test('static transport has no shared credentials or session fallback',async()=>{
  let calls=0;const upstreamFetch=()=>{calls++;},data=await body('grade'),fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch});
  const missing=options('grade',data);delete missing.headers['X-Api-Key'];
  const requests=[
    fetcher('/api/grade',missing),
    fetcher('/api/grade',options('grade',data,{credentialMode:'managed'})),
    fetcher('/api/grade',options('grade',data,{headers:{...options('grade',data).headers,cookie:'grading_session=synthetic-only'}})),
    createBrowserAPIFetch({origin:ORIGIN,upstreamFetch,credentialMode:'managed'})('/api/grade',options('grade',data)),
  ];
  for(const reply of await Promise.all(requests)){const out=await reply.json();assert.ok(reply.status>=400);assert.equal(out.notSent,true);assert.equal(out.estimatedCny,0);}
  assert.equal(calls,0);
});

test('static transport never reuses a previous stage key',async()=>{
  const calls=[],fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async(_url,init)=>{calls.push(init);return response('kimi','prepare');}});
  assert.equal((await fetcher('/api/prepare',options('prepare',await body('prepare','kimi')))).status,200);
  const next=options('review',await body('review','kimi'));delete next.headers['X-Api-Key'];
  const out=await (await fetcher('/api/review',next)).json();assert.equal(out.code,'MISSING_KEY');assert.equal(out.notSent,true);assert.equal(calls.length,1);
});

test('unapproved providers/models, endpoint overrides and bad evidence fail before transport',async()=>{
  let calls=0;const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:()=>{calls++;}});
  const changes=[data=>data.stageProfiles.grade.provider='openai',data=>data.stageProfiles.grade.model='not-supported',data=>data.stageProfiles.grade.endpoint='https://evil.example',data=>data.base_url='https://evil.example',data=>data.pages[0].sha256='0'.repeat(64),data=>data.initialResultHash='0'.repeat(64)];
  for(const change of changes){const action=change===changes.at(-1)?'review':'grade',data=await body(action);change(data);const reply=await fetcher('/api/'+action,options(action,data)),out=await reply.json();assert.ok(reply.status>=400);assert.equal(out.notSent,true);assert.equal(out.estimatedCny,0);}
  assert.equal(calls,0);
});

test('cross-origin and invalid browser origins cannot initialize the in-memory transport',async()=>{
  let calls=0;const data=await body('grade');
  for(const origin of ['file:///local/index.html','https://user:secret@example.org','https://example.org/other-path','null','']){
    const fetcher=createBrowserAPIFetch({origin,upstreamFetch:()=>{calls++;}}),out=await (await fetcher('/api/grade',options('grade',data))).json();assert.equal(out.code,'BROWSER_REQUEST');assert.equal(out.notSent,true);
  }
  assert.equal(calls,0);
});

test('browser network interruption is one uncertain paid attempt and redacts credentials',async()=>{
  let calls=0;const data=await body('grade'),fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async()=>{calls++;throw Error(KEYS.grade);}});
  const out=await (await fetcher('/api/grade',options('grade',data))).json();
  assert.equal(calls,1);assert.equal(out.code,'NETWORK');assert.equal(out.uncertain,true);assert.equal(out.notSent,false);assert.equal(out.estimatedCny,null);assert.equal(out.requestId,data.requestId);assert.ok(!JSON.stringify(out).includes(KEYS.grade));
});

test('browser manual redirects, including opaque redirects, never trigger a second request',async()=>{
  for(const upstream of [()=>new Response('',{status:307,headers:{location:'https://evil.example'}}),()=>({status:0,ok:false,type:'opaqueredirect',body:null,headers:new Headers()})]){
    let calls=0;const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async()=>{calls++;return upstream();}}),data=await body('grade');
    const out=await (await fetcher('/api/grade',options('grade',data))).json();assert.equal(calls,1);assert.equal(out.code,'UPSTREAM_REDIRECT');assert.equal(out.uncertain,true);assert.equal(out.notSent,false);assert.equal(out.estimatedCny,null);
  }
});

test('browser invalid result preserves known cost without inventing a score or retrying',async()=>{
  let calls=0;const invalid=result();invalid.criteria[0].awarded=999;
  const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async()=>{calls++;return response('deepseek','grade',invalid);}}),data=await body('grade');
  const out=await (await fetcher('/api/grade',options('grade',data))).json();assert.equal(calls,1);assert.equal(out.code,'VALIDATION');assert.equal(out.result,undefined);assert.equal(out.estimatedCny,0.00405);assert.equal(out.uncertain,false);assert.ok(out.raw);
});

test('browser successful result with unknown usage keeps cost unresolved',async()=>{
  let calls=0;const fetcher=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async()=>{calls++;return response('deepseek','grade',result(),{usage:undefined});}}),data=await body('grade');
  const reply=await fetcher('/api/grade',options('grade',data)),out=await reply.json();assert.equal(reply.status,200);assert.equal(calls,1);assert.ok(out.result);assert.equal(out.estimatedCny,null);assert.equal(out.usage,null);
});

test('browser cancellation before send is free; cancellation in flight stays uncertain',async()=>{
  const data=await body('grade');let calls=0;
  const cancelled=new AbortController();cancelled.abort();
  const noSend=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:()=>{calls++;}});
  const early=await (await noSend('/api/grade',options('grade',data,{signal:cancelled.signal}))).json();assert.equal(early.code,'REQUEST_ABORTED');assert.equal(early.notSent,true);assert.equal(early.estimatedCny,0);assert.equal(calls,0);
  const controller=new AbortController();
  const inFlight=createBrowserAPIFetch({origin:ORIGIN,upstreamFetch:async(_url,init)=>{calls++;return new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(new Error('synthetic abort')),{once:true});controller.abort();});}});
  const late=await (await inFlight('/api/grade',options('grade',data,{signal:controller.signal}))).json();assert.equal(calls,1);assert.equal(late.code,'NETWORK');assert.equal(late.uncertain,true);assert.equal(late.notSent,false);assert.equal(late.estimatedCny,null);
});

test('browser module dependency graph contains no server runtime, Node builtins or environment secrets',async()=>{
  const visited=new Set();
  async function visit(url){
    if(visited.has(url.href))return;visited.add(url.href);
    assert.ok(!url.pathname.endsWith('/server-runtime.mjs'));assert.ok(!url.pathname.endsWith('/api-service.mjs'));
    const source=await readFile(url,'utf8');assert.doesNotMatch(source,/\bprocess\.env\b|GRADING_(?:API_KEY|PREPARE_API_KEY|REVIEW_API_KEY|SESSION_SECRET|ACCESS_CODE)/);
    const dependencies=[...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)].map(match=>match[1]);
    for(const specifier of dependencies){assert.ok(specifier.startsWith('./')||specifier.startsWith('../'),`Non-browser dependency ${specifier}`);await visit(new URL(specifier,url));}
  }
  await visit(new URL('../lib/grading/browser-api.mjs',import.meta.url));assert.ok(visited.size>=7);
});
