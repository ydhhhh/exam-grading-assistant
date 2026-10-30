import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRuntimeAPI,handleAPI} from '../lib/grading/api-service.mjs';
import {resolveRuntime,runWithGradingEnvironment,handleRuntimeConfig,handleSession,isAuthenticated} from '../lib/grading/server-runtime.mjs';
import {validateReviewProfile,profilesEqual,estimateReviewCny,reviewResultHash} from '../lib/grading/review-profile.mjs';
import {DEFAULT_STAGE_PROFILES,getDefaultProfile,getProvider,validateStageProfiles,stageProfilesEqual,normalizeProviderUsage} from '../lib/grading/providers.mjs';

// Only synthetic credentials, materials and responses; no live API is invoked.
const STAGES=structuredClone(DEFAULT_STAGE_PROFILES),PROFILE=STAGES.review;
const ENV={GRADING_MODE:'managed',GRADING_STAGE_PROFILES:JSON.stringify(STAGES),GRADING_PREPARE_API_KEY:'synthetic-server-prepare-key',GRADING_API_KEY:'synthetic-server-primary-key',GRADING_REVIEW_API_KEY:'synthetic-server-review-key',GRADING_ACCESS_CODE:'synthetic-staff-access-code',GRADING_SESSION_SECRET:'synthetic-session-signing-secret-more-than-32'};
const PACK={exam_id:'SYNTHETIC',title:'Synthetic test',version:'v1',demo:false,approved_by:'Test teacher',policies:'Use explicit rubric.',questions:[{question_id:'Q1',text:'Find P(A).',solution:'0.5',max_score:2,criteria:[{criterion_id:'C1',description:'Answer',allowed_scores:[0,1,2],requires:[]}]}]};
const RESULT={question_id:'Q1',status:'scored',criteria:[{criterion_id:'C1',awarded:2,evidence_refs:['P1'],reason:'Synthetic evidence observed.'}],flags:[],alternative_solution:false};
const IDENTITY={name:'Synthetic',student_id:'9000001',name_status:'readable',student_id_status:'readable',warnings:[]};
const request=(path,data,headers={},method='POST')=>new Request('https://grading.example'+path,{method,headers:{origin:'https://grading.example','content-type':'application/json',...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
async function image(){
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {name:'private-student-name.png',mime:'image/png',sha256:hash,data:btoa(String.fromCharCode(...bytes))};
}
async function body(action='grade',stages=STAGES){
  const base={stageProfiles:structuredClone(stages),requestId:'synthetic-request'},file=await image();
  if(action==='prepare')return {...base,documents:['paper','solution','rubric'].map(role=>({role,sourceMime:file.mime,sourceSha256:file.sha256,files:[file]}))};
  if(action==='identity')return {...base,page:{page_id:'P1',...file}};
  return {...base,pack:structuredClone(PACK),questionId:'Q1',pages:[{page_id:'P1',...file}],...(action==='review'?{reviewProfile:structuredClone(stages.review),initialResult:structuredClone(RESULT),initialResultHash:await reviewResultHash(RESULT)}:{})};
}
function envelope(profile,result=RESULT,usage={input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:500}}){
  if(getProvider(profile.provider).protocol==='responses')return {id:'synthetic-response',model:profile.model,status:'completed',usage,output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(result)}]}]};
  return {id:'synthetic-response',model:profile.model,usage:usage&&{prompt_tokens:usage.input_tokens,completion_tokens:usage.output_tokens,prompt_tokens_details:usage.input_tokens_details},choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result),reasoning_content:'SYNTHETIC-REASONING-NOT-A-SCORE'}}]};
}
async function session(runtime=resolveRuntime(ENV)){
  const response=await handleSession(request('/api/session',{accessCode:ENV.GRADING_ACCESS_CODE}),runtime);
  assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0];
}
async function call(action,data,{runtime=resolveRuntime(ENV),cookie,headers={},response,status=200}={}){
  const calls=[];cookie??=runtime.mode==='managed'&&runtime.ready?await session(runtime):'';
  response??=envelope(data?.stageProfiles?.[action==='identity'?'grade':action]||STAGES.grade,action==='identity'?IDENTITY:action==='prepare'?{pack:{...PACK,approved_by:''},warnings:[]}:RESULT);
  const result=await handleRuntimeAPI(request('/api/'+action,data,{cookie,...headers}),action,async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(response),{status});},runtime);
  return {response:result,data:await result.json(),calls};
}

test('production fails closed; explicit test mode defaults to Kimi / DeepSeek / Kimi',async()=>{
  for(const env of [{},{GRADING_MODE:'unknown'},{...ENV,GRADING_API_KEY:''},{...ENV,GRADING_PREPARE_API_KEY:''},{...ENV,GRADING_REVIEW_API_KEY:''},{...ENV,GRADING_SESSION_SECRET:'short'}]){
    const x=await call('grade',await body(),{runtime:resolveRuntime(env),cookie:''});assert.equal(x.calls.length,0);assert.equal(x.data.estimatedCny,0);assert.equal(x.response.status,503);
  }
  const config=resolveRuntime({GRADING_MODE:'test'});assert.equal(config.ready,true);assert.deepEqual(config.stageProfiles,STAGES);assert.deepEqual(config.reviewProfile,PROFILE);
});
test('public runtime configuration never includes any stage key or session secret',async()=>{
  const runtime=resolveRuntime(ENV),cookie=await session(runtime);
  const response=await handleRuntimeConfig(request('/api/runtime-config',undefined,{cookie},'GET'),runtime),json=await response.json();
  assert.equal(json.authenticated,true);assert.deepEqual(json.stageProfiles,STAGES);assert.equal(json.mode,'managed');assert.equal(json.stageKeys,undefined);
  for(const secret of [ENV.GRADING_PREPARE_API_KEY,ENV.GRADING_API_KEY,ENV.GRADING_REVIEW_API_KEY,ENV.GRADING_ACCESS_CODE,ENV.GRADING_SESSION_SECRET])assert.ok(!JSON.stringify(json).includes(secret));
  assert.match(response.headers.get('cache-control'),/no-store/);
});
test('request-scoped environments remain isolated across concurrent async requests',async()=>{
  const results=await Promise.all([runWithGradingEnvironment({GRADING_MODE:'test'},async()=>{await Promise.resolve();return resolveRuntime();}),runWithGradingEnvironment(ENV,async()=>{await Promise.resolve();return resolveRuntime();})]);
  assert.equal(results[0].provider,'deepseek');assert.equal(results[0].stageKeys,undefined);assert.equal(results[1].stageKeys.grade,ENV.GRADING_API_KEY);
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
test('wrong code, foreign origin and oversized login cannot create a session',async()=>{
  for(const req of [request('/api/session',{accessCode:'wrong'}),request('/api/session',{accessCode:ENV.GRADING_ACCESS_CODE},{origin:'https://evil.example'}),request('/api/session',{accessCode:'x'.repeat(3000)})]){
    const response=await handleSession(req,resolveRuntime(ENV));assert.ok(response.status>=400);assert.equal(response.headers.get('set-cookie'),null);
  }
  const logout=await handleSession(request('/api/session',undefined,{},'DELETE'),resolveRuntime(ENV));assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
});
test('managed calls require signed session and reject caller keys or model substitution',async()=>{
  for(const options of [{cookie:''},{headers:{'x-api-key':'caller-key-that-must-not-be-used'}},{headers:{'x-api-provider':'kimi'}}]){
    const x=await call('grade',await body(),options);assert.equal(x.calls.length,0);assert.equal(x.data.estimatedCny,0);assert.equal(x.data.notSent,true);assert.ok(x.response.status>=400);
  }
  const b=await body();b.stageProfiles.grade=getDefaultProfile('qwen');const changed=await call('grade',b);assert.equal(changed.calls.length,0);assert.equal(changed.data.code,'STAGE_PROFILE_CHANGED');
});
test('managed each stage sends exactly its own key including same-provider preparation and review',async()=>{
  for(const [action,key] of [['prepare',ENV.GRADING_PREPARE_API_KEY],['identity',ENV.GRADING_API_KEY],['grade',ENV.GRADING_API_KEY],['review',ENV.GRADING_REVIEW_API_KEY]]){
    const b=await body(action),x=await call(action,b);assert.equal(x.response.status,200,JSON.stringify(x.data));assert.equal(x.calls.length,1);
    assert.equal(x.calls[0].options.headers.authorization,'Bearer '+key);assert.deepEqual(x.data.stageProfile,b.stageProfiles[action==='identity'?'grade':action]);
    for(const secret of Object.values(resolveRuntime(ENV).stageKeys))assert.ok(!JSON.stringify(x.data).includes(secret));
  }
});
test('test mode uses only the key from that request and never falls back to server keys',async()=>{
  const runtime=resolveRuntime({GRADING_MODE:'test'}),key='synthetic-test-browser-key';
  for(const action of ['prepare','grade','review']){
    let x=await call(action,await body(action),{runtime,headers:{'x-api-key':key}});assert.equal(x.response.status,200);assert.equal(x.calls[0].options.headers.authorization,'Bearer '+key);
    x=await call(action,await body(action),{runtime});assert.equal(x.data.code,'MISSING_KEY');assert.equal(x.calls.length,0);
  }
});
test('review sees original evidence but never initial reasons, flags, score, hash or filename',async()=>{
  const b=await body('review');b.initialResult.criteria[0].reason='UNTRUSTED-INITIAL-MARKER';b.initialResultHash=await reviewResultHash(b.initialResult);
  const x=await call('review',b);assert.equal(x.response.status,200);const wire=x.calls[0].options.body,sent=JSON.parse(wire);
  assert.equal(sent.model,PROFILE.model);assert.equal(sent.reasoning_effort,'max');assert.equal(sent.max_completion_tokens,16000);assert.equal(sent.tools,undefined);
  assert.equal(sent.response_format.json_schema.strict,true);assert.ok(sent.messages[1].content.some(c=>c.type==='image_url'));
  assert.ok(!wire.includes('UNTRUSTED-INITIAL-MARKER'));assert.ok(!wire.includes(b.initialResultHash));assert.ok(!wire.includes('private-student-name'));
  assert.deepEqual(x.data.reviewProfile,PROFILE);assert.equal(x.data.initialResultHash,b.initialResultHash);assert.deepEqual(x.data.result,RESULT);assert.equal(x.data.estimatedCny,.01395);
});
test('review binding, initial hash, file hash and score semantics are checked before billing',async()=>{
  for(const change of [b=>b.reviewProfile.model='unconfigured-model',b=>b.initialResultHash='0'.repeat(64),b=>b.initialResult.criteria[0].awarded=99,b=>b.pages[0].sha256='0'.repeat(64),b=>b.extraSecret='forbidden']){
    const b=await body('review');change(b);const x=await call('review',b);assert.equal(x.calls.length,0);assert.ok(x.response.status>=400);assert.equal(x.data.result,undefined);assert.equal(x.data.estimatedCny,0);assert.equal(x.data.notSent,true);
  }
});
test('review preserves charged invalid results and unknown usage without adopting scores or retrying',async()=>{
  const invalid=structuredClone(RESULT);invalid.criteria[0].awarded=99;
  let x=await call('review',await body('review'),{response:envelope(PROFILE,invalid)});assert.equal(x.data.code,'VALIDATION');assert.equal(x.data.result,undefined);assert.equal(x.data.estimatedCny,.01395);assert.equal(x.calls.length,1);assert.ok(x.data.raw);
  x=await call('review',await body('review'),{response:envelope(PROFILE,RESULT,null)});assert.equal(x.data.estimatedCny,null);assert.equal(x.calls.length,1);assert.deepEqual(x.data.result,RESULT);
});
test('review network failure retains profile binding and redacts key without retry',async()=>{
  const runtime=resolveRuntime(ENV),cookie=await session(runtime),b=await body('review');let calls=0;
  const response=await handleRuntimeAPI(request('/api/review',b,{cookie}),'review',async()=>{calls++;throw Error(ENV.GRADING_REVIEW_API_KEY);},runtime),data=await response.json();
  assert.equal(calls,1);assert.equal(data.uncertain,true);assert.equal(data.notSent,false);assert.equal(data.estimatedCny,null);assert.deepEqual(data.reviewProfile,PROFILE);assert.equal(data.initialResultHash,b.initialResultHash);assert.ok(!JSON.stringify(data).includes(ENV.GRADING_REVIEW_API_KEY));
});
test('stage profiles reject GPT, custom origins, unknown models, missing prices and same-model review',()=>{
  for(const profile of [{...PROFILE,url:'https://evil.example'},{...PROFILE,provider:'openai'},{...PROFILE,model:'gpt-6.1-terra'},{...PROFILE,pricing:{input:1,output:1}},{...PROFILE,pricing:{...PROFILE.pricing,cachedInput:99}},{...PROFILE,outputTokens:Infinity}])assert.throws(()=>validateReviewProfile(profile));
  assert.throws(()=>getProvider('openai'));assert.throws(()=>validateStageProfiles({...STAGES,review:STAGES.grade}));
  assert.equal(profilesEqual(PROFILE,{...PROFILE,pricing:{...PROFILE.pricing}}),true);assert.equal(profilesEqual(PROFILE,{...PROFILE,model:'different-model'}),false);
  assert.equal(stageProfilesEqual(STAGES,structuredClone(STAGES)),true);
  assert.equal(estimateReviewCny({input_tokens:10,output_tokens:2,input_tokens_details:{cached_tokens:99}},PROFILE),null);
});
test('Kimi and both Qwen models support each stage with provider-specific request and final-content parsing',async()=>{
  for(const [provider,model] of [['kimi','kimi-k3.1-pro'],['qwen','qwen3.8-max'],['qwen','qwen3.8-flash']])for(const action of ['prepare','identity','grade','review']){
    const stages=structuredClone(STAGES),stage=action==='identity'?'grade':action;stages[stage]=getDefaultProfile(provider,stage,model);
    if(stage==='grade'&&provider==='kimi')stages.review=getDefaultProfile('qwen');
    const b=await body(action,stages),x=await call(action,b,{runtime:resolveRuntime({GRADING_MODE:'test'}),headers:{'x-api-key':'synthetic-client-stage-key','x-api-provider':provider}});
    assert.equal(x.response.status,200,JSON.stringify(x.data));const sent=JSON.parse(x.calls[0].options.body);
    assert.equal(sent.model,model);assert.equal(sent.temperature,undefined);assert.equal(sent.top_p,undefined);assert.equal(sent.tools,undefined);assert.equal(sent.messages[0].role,'system');
    assert.ok(sent.messages[1].content.some(c=>c.type==='image_url'&&c.image_url.url.startsWith('data:image/png;base64,')));
    assert.equal(new URL(x.calls[0].url).hostname,provider==='kimi'?'api.moonshot.cn':'dashscope.aliyuncs.com');
    if(provider==='qwen'){assert.equal(sent.response_format.type,'json_object');assert.match(sent.messages[0].content,/JSON Schema/);assert.equal(sent.reasoning_effort,'xhigh');assert.equal(sent.enable_thinking,true);}
    else {assert.equal(sent.response_format.type,'json_schema');assert.ok(sent.max_completion_tokens);}
    assert.ok(x.data.usage);assert.ok(x.data.estimatedCny>0);assert.deepEqual(x.data.stageProfile,stages[stage]);
  }
});
test('Chat truncation, tool calls, refusals and invalid final JSON never become scores',async()=>{
  const stages={...structuredClone(STAGES),grade:getDefaultProfile('qwen')},b=await body('grade',stages);
  for(const [change,code] of [
    [e=>e.choices[0].finish_reason='length','INCOMPLETE'],
    [e=>e.choices[0].message.tool_calls=[{type:'function'}],'UNEXPECTED_OUTPUT'],
    [e=>e.choices[0].message.role='system','UNEXPECTED_OUTPUT'],
    [e=>e.choices[0].message.refusal='cannot','REFUSAL'],
    [e=>e.choices[0].message.content='','EMPTY_OUTPUT'],
    [e=>e.choices[0].message.content='{broken','INVALID_RESULT_JSON'],
  ]){
    const response=envelope(stages.grade);change(response);
    const x=await call('grade',b,{runtime:resolveRuntime({GRADING_MODE:'test'}),headers:{'x-api-key':'synthetic-client-stage-key'},response});
    assert.equal(x.data.code,code);assert.equal(x.data.result,undefined);assert.equal(x.calls.length,1);assert.ok(x.data.raw);assert.ok(x.data.estimatedCny>0);assert.equal(x.data.uncertain,false);
  }
});
test('all domestic endpoints refuse redirects without forwarding a key',async()=>{
  for(const provider of ['kimi','deepseek','qwen']){
    const stages={...structuredClone(STAGES),grade:getDefaultProfile(provider),review:getDefaultProfile(provider==='kimi'?'deepseek':'kimi')};
    const b=await body('grade',stages);let calls=0;
    const response=await handleAPI(request('/api/grade',b,{'x-api-key':'synthetic-client-stage-key'}),'grade',async(_url,opts)=>{calls++;assert.equal(opts.redirect,'manual');return new Response('',{status:307,headers:{location:'https://untrusted.example/collect'}});});
    const data=await response.json();assert.equal(data.code,'UPSTREAM_REDIRECT');assert.equal(data.uncertain,true);assert.equal(calls,1);
  }
});
test('Chat usage rejects malformed counts and never counts reasoning twice',()=>{
  assert.deepEqual(normalizeProviderUsage({prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:50},completion_tokens_details:{reasoning_tokens:10}},'chat'),{input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:50}});
  for(const usage of [{prompt_tokens:1,completion_tokens:-1},{prompt_tokens:100,completion_tokens:20,prompt_tokens_details:{cached_tokens:101}},{prompt_tokens:100,completion_tokens:'20'}])assert.equal(normalizeProviderUsage(usage,'chat'),null);
});

test('invalid administrator profile JSON cannot leak embedded credentials through public configuration',async()=>{
  for(const mutate of [p=>p.prepare.apiKey='synthetic-secret-must-never-be-public',p=>p.review.base_url='https://synthetic-secret-must-never-be-public.example',p=>p.secret='synthetic-secret-must-never-be-public']){
    const profiles=structuredClone(STAGES);mutate(profiles);
    const runtime=resolveRuntime({...ENV,GRADING_STAGE_PROFILES:JSON.stringify(profiles)});
    assert.equal(runtime.ready,false);
    const data=await (await handleRuntimeConfig(request('/api/runtime-config',undefined,{},'GET'),runtime)).json();
    assert.ok(!JSON.stringify(data).includes('synthetic-secret-must-never-be-public'));
    assert.deepEqual(data.stageProfiles,STAGES);
  }
});
