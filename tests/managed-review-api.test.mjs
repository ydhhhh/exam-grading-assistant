import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRuntimeAPI} from '../lib/grading/api-service.mjs';
import {resolveRuntime,runWithGradingEnvironment,handleRuntimeConfig,handleSession,isAuthenticated} from '../lib/grading/server-runtime.mjs';
import {validateReviewProfile,profilesEqual,estimateReviewCny,reviewResultHash} from '../lib/grading/review-profile.mjs';

// Deliberately fictitious model, credentials and rates: these tests never call a provider.
const PROFILE={provider:'openai',model:'synthetic-review-model',reasoning:'high',outputTokens:12000,pricing:{input:4,cachedInput:1,output:20,budgetFx:7.5,version:'synthetic-test-only'}};
const ENV={GRADING_MODE:'managed',GRADING_PROVIDER:'openai',GRADING_API_KEY:'synthetic-server-primary-key',GRADING_REVIEW_API_KEY:'synthetic-server-review-key',GRADING_ACCESS_CODE:'synthetic-staff-access-code',GRADING_SESSION_SECRET:'synthetic-session-signing-secret-more-than-32',GRADING_REVIEW_PROFILE:JSON.stringify(PROFILE)};
const PACK={exam_id:'SYNTHETIC',title:'Synthetic test',version:'v1',demo:false,approved_by:'Test teacher',policies:'Use explicit rubric.',questions:[{question_id:'Q1',text:'Find P(A).',solution:'0.5',max_score:2,criteria:[{criterion_id:'C1',description:'Answer',allowed_scores:[0,1,2],requires:[]}]}]};
const RESULT={question_id:'Q1',status:'scored',criteria:[{criterion_id:'C1',awarded:2,evidence_refs:['P1'],reason:'Synthetic evidence observed.'}],flags:[],alternative_solution:false};
const request=(path,data,headers={},method='POST')=>new Request('https://grading.example'+path,{method,headers:{origin:'https://grading.example','content-type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
async function body(review=false){
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {pack:structuredClone(PACK),questionId:'Q1',requestId:'synthetic-request',pages:[{page_id:'P1',name:'private-student-name.png',mime:'image/png',sha256:hash,data:btoa(String.fromCharCode(...bytes))}],...(review?{reviewProfile:structuredClone(PROFILE),initialResult:structuredClone(RESULT),initialResultHash:await reviewResultHash(RESULT)}:{})};
}
const envelope=(result=RESULT,usage={input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:500}})=>({id:'synthetic-response',model:PROFILE.model,status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
async function session(runtime=resolveRuntime(ENV)){
  const response=await handleSession(request('/api/session',{accessCode:ENV.GRADING_ACCESS_CODE}),runtime);
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}
async function call(action,data,{runtime=resolveRuntime(ENV),cookie,headers={},response=envelope(),status=200}={}){
  const calls=[];cookie??=runtime.mode==='managed'&&runtime.ready?await session(runtime):'';
  const result=await handleRuntimeAPI(request('/api/'+action,data,{cookie,...headers}),action,async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(response),{status});},runtime);
  return {response:result,data:await result.json(),calls};
}

test('production configuration fails closed; test mode is explicit and contains no default reviewer',async()=>{
  for(const env of [{},{GRADING_MODE:'unknown'},{...ENV,GRADING_API_KEY:''},{...ENV,GRADING_SESSION_SECRET:'short'}]){
    const x=await call('grade',await body(),{runtime:resolveRuntime(env),cookie:''});assert.equal(x.calls.length,0);assert.equal(x.data.estimatedCny,0);assert.equal(x.response.status,503);
  }
  const config=resolveRuntime({GRADING_MODE:'test'});assert.equal(config.ready,true);assert.equal(config.reviewProfile,null);
});
test('runtime config returns only public configuration and a session flag',async()=>{
  const runtime=resolveRuntime(ENV),cookie=await session(runtime);
  const response=await handleRuntimeConfig(request('/api/runtime-config',undefined,{cookie},'GET'),runtime),json=await response.json();
  assert.equal(json.authenticated,true);assert.deepEqual(json.reviewProfile,PROFILE);assert.equal(json.mode,'managed');
  for(const secret of [ENV.GRADING_API_KEY,ENV.GRADING_REVIEW_API_KEY,ENV.GRADING_ACCESS_CODE,ENV.GRADING_SESSION_SECRET])assert.ok(!JSON.stringify(json).includes(secret));
  assert.match(response.headers.get('cache-control'),/no-store/);
});
test('request-scoped environments remain isolated across concurrent async requests',async()=>{
  const results=await Promise.all([runWithGradingEnvironment({GRADING_MODE:'test',GRADING_PROVIDER:'deepseek'},async()=>{await Promise.resolve();return resolveRuntime();}),runWithGradingEnvironment(ENV,async()=>{await Promise.resolve();return resolveRuntime();})]);
  assert.equal(results[0].provider,'deepseek');assert.equal(results[0].apiKey,undefined);assert.equal(results[1].apiKey,ENV.GRADING_API_KEY);assert.equal(resolveRuntime().ready,false);
});
test('staff session is HttpOnly, secure, origin-bound, expiring and revoked by secret rotation',async()=>{
  const runtime=resolveRuntime(ENV),now=Date.now();
  const response=await handleSession(request('/api/session',{accessCode:ENV.GRADING_ACCESS_CODE}),runtime,now),set=response.headers.get('set-cookie'),cookie=set.split(';')[0];
  assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Strict/);assert.match(set,/Secure/);
  const req=request('/api/grade',undefined,{cookie});assert.equal(await isAuthenticated(req,runtime,now),true);
  assert.equal(await isAuthenticated(req,runtime,now+8*3600*1000),false);
  assert.equal(await isAuthenticated(req,{...runtime,accessCode:'rotated-access-code'},now),false);
  assert.equal(await isAuthenticated(req,{...runtime,sessionSecret:'rotated-session-secret'},now),false);
  assert.equal(await isAuthenticated(new Request('https://another.example/api/grade',{headers:{cookie}}),runtime,now),false);
  assert.equal(await isAuthenticated(request('/api/grade',undefined,{cookie:cookie.slice(0,-2)+'xx'}),runtime,now),false);
});
test('wrong code, foreign origin and oversized login body cannot create sessions',async()=>{
  for(const req of [request('/api/session',{accessCode:'wrong'}),request('/api/session',{accessCode:ENV.GRADING_ACCESS_CODE},{origin:'https://evil.example'}),request('/api/session',{accessCode:'x'.repeat(3000)})]){
    const response=await handleSession(req,resolveRuntime(ENV));assert.ok(response.status>=400);assert.equal(response.headers.get('set-cookie'),null);
  }
  const logout=await handleSession(request('/api/session',undefined,{},'DELETE'),resolveRuntime(ENV));assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
});
test('managed paid calls require signed session and reject caller keys or provider override',async()=>{
  for(const options of [{cookie:''},{headers:{'x-api-key':'caller-key-that-must-not-be-used'}},{headers:{'x-api-provider':'deepseek'}}]){
    const x=await call('grade',await body(),options);assert.equal(x.calls.length,0);assert.equal(x.data.estimatedCny,0);assert.equal(x.data.notSent,true);assert.equal(x.data.provider,'openai');assert.ok(x.response.status>=400);
  }
  const x=await call('grade',await body());assert.equal(x.response.status,200);assert.equal(x.calls[0].options.headers.authorization,'Bearer '+ENV.GRADING_API_KEY);assert.ok(!JSON.stringify(x.data).includes(ENV.GRADING_API_KEY));
});
test('test mode preserves BYOK only after explicit server enablement',async()=>{
  const key='synthetic-test-browser-key';
  const x=await call('grade',await body(),{runtime:resolveRuntime({GRADING_MODE:'test'}),headers:{'x-api-key':key}});assert.equal(x.response.status,200);assert.equal(x.calls[0].options.headers.authorization,'Bearer '+key);
});
test('review sends original evidence to configured independent model without forwarding initial result',async()=>{
  const b=await body(true),x=await call('review',b);assert.equal(x.response.status,200);assert.equal(x.calls.length,1);
  const sent=JSON.parse(x.calls[0].options.body);assert.equal(sent.model,PROFILE.model);assert.equal(sent.reasoning.effort,'high');assert.equal(sent.max_output_tokens,12000);assert.equal(sent.previous_response_id,undefined);assert.equal(sent.tools,undefined);
  assert.equal(x.calls[0].options.headers.authorization,'Bearer '+ENV.GRADING_REVIEW_API_KEY);assert.ok(sent.input[0].content.some(c=>c.type==='input_image'));assert.ok(!sent.input[0].content.some(c=>c.text?.includes('待复核的初评结果')));assert.ok(!x.calls[0].options.body.includes(RESULT.criteria[0].reason));assert.ok(!x.calls[0].options.body.includes('private-student-name'));
  assert.deepEqual(x.data.reviewProfile,PROFILE);assert.equal(x.data.initialResultHash,b.initialResultHash);assert.deepEqual(x.data.result,RESULT);assert.equal(x.data.estimatedCny,.03375);
});
test('review config, initial-result hash and scoring semantics are checked before a paid call',async()=>{
  for(const change of [b=>b.reviewProfile.model='unconfigured-model',b=>b.initialResultHash='0'.repeat(64),b=>b.initialResult.criteria[0].awarded=99,b=>b.pages[0].sha256='0'.repeat(64),b=>b.extraSecret='forbidden']){
    const b=await body(true);change(b);const x=await call('review',b);assert.equal(x.calls.length,0);assert.ok(x.response.status>=400);assert.equal(x.data.result,undefined);assert.equal(x.data.estimatedCny,0);assert.equal(x.data.notSent,true);
  }
  const runtime=resolveRuntime({...ENV,GRADING_REVIEW_PROFILE:''}),x=await call('review',await body(true),{runtime});assert.equal(x.calls.length,0);assert.equal(x.data.code,'REVIEW_UNCONFIGURED');
});
test('review preserves paid invalid results and unknown usage without adopting scores or retrying',async()=>{
  const invalid=structuredClone(RESULT);invalid.criteria[0].awarded=99;
  let x=await call('review',await body(true),{response:envelope(invalid)});assert.equal(x.data.code,'VALIDATION');assert.equal(x.data.result,undefined);assert.equal(x.data.estimatedCny,.03375);assert.equal(x.calls.length,1);assert.ok(x.data.raw);
  x=await call('review',await body(true),{response:envelope(RESULT,null)});assert.equal(x.data.estimatedCny,null);assert.equal(x.calls.length,1);assert.deepEqual(x.data.result,RESULT);
});
test('review network failure retains profile binding and redacts server key without retry',async()=>{
  const runtime=resolveRuntime(ENV),cookie=await session(runtime),b=await body(true);let calls=0;
  const response=await handleRuntimeAPI(request('/api/review',b,{cookie}),'review',async()=>{calls++;throw Error(ENV.GRADING_REVIEW_API_KEY);},runtime),data=await response.json();
  assert.equal(calls,1);assert.equal(data.uncertain,true);assert.equal(data.notSent,false);assert.equal(data.estimatedCny,null);assert.deepEqual(data.reviewProfile,PROFILE);assert.equal(data.initialResultHash,b.initialResultHash);assert.ok(!JSON.stringify(data).includes(ENV.GRADING_REVIEW_API_KEY));
});
test('review profile forbids custom URLs, extra fields, missing rates and same configured initial model',()=>{
  for(const profile of [{...PROFILE,url:'https://evil.example'},{...PROFILE,provider:'https://evil.example'},{...PROFILE,pricing:{input:1,output:1}},{...PROFILE,pricing:{...PROFILE.pricing,cachedInput:99}},{...PROFILE,outputTokens:Infinity}])assert.throws(()=>validateReviewProfile(profile));
  assert.equal(profilesEqual(PROFILE,{...PROFILE,pricing:{...PROFILE.pricing}}),true);assert.equal(profilesEqual(PROFILE,{...PROFILE,model:'different-model'}),false);
  assert.equal(resolveRuntime({...ENV,GRADING_REVIEW_PROFILE:JSON.stringify({...PROFILE,model:'gpt-6.1-terra'})}).ready,false);
  assert.equal(estimateReviewCny({input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:99}},PROFILE),null);
});
test('different-provider reviewer requires its own server key and never receives the primary key',async()=>{
  const profile={...PROFILE,provider:'deepseek'},runtime=resolveRuntime({...ENV,GRADING_REVIEW_PROFILE:JSON.stringify(profile)});
  assert.equal(resolveRuntime({...ENV,GRADING_REVIEW_PROFILE:JSON.stringify(profile),GRADING_REVIEW_API_KEY:''}).ready,false);
  const b=await body(true);b.reviewProfile=profile;
  const x=await call('review',b,{runtime,headers:{'x-api-provider':'deepseek'}});assert.equal(x.response.status,200);assert.equal(x.calls[0].url,'https://api.deepseek.com/responses');assert.equal(x.calls[0].options.headers.authorization,'Bearer '+ENV.GRADING_REVIEW_API_KEY);
});
