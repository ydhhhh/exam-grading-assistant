import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAPI,estimateCny,PACK_SCHEMA,RESULT_SCHEMA,IDENTITY_SCHEMA,API_SETTINGS} from '../lib/grading/api-service.mjs';
const fixturePack=()=>({exam_id:'EXAM',title:'Synthetic only',version:'v1',demo:false,approved_by:'Teacher',policies:'Use stated rubric; no invented conditions.',questions:[{question_id:'Q1',text:'Find P(A).',solution:'0.5',max_score:5,criteria:[{criterion_id:'C1',description:'Method',allowed_scores:[0,1,2],requires:[]},{criterion_id:'C2',description:'Result',allowed_scores:[0,1.5,3],requires:[]}]}]});
const fixtureResult=()=>({question_id:'Q1',status:'scored',criteria:[{criterion_id:'C1',awarded:2,evidence_refs:['P1'],reason:'method observed'},{criterion_id:'C2',awarded:3,evidence_refs:['P1'],reason:'result observed'}],flags:[],alternative_solution:false});

import {DEFAULT_STAGE_PROFILES,getDefaultProfile} from '../lib/grading/providers.mjs';
const testStages=()=>({...structuredClone(DEFAULT_STAGE_PROFILES),prepare:getDefaultProfile('deepseek','prepare')});
const KEY='test-placeholder-key-no-live-call';
async function file(){const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {name:'private-student-name.png',mime:'image/png',data:btoa(String.fromCharCode(...bytes)),sha256};}
async function body(){return {pack:fixturePack(),questionId:'Q1',pages:[{page_id:'P1',...await file()}],requestId:'request-001'};}
function request(data,headers={},url='https://grading.example/api/grade'){return new Request(url,{method:'POST',headers:{origin:new URL(url).origin,'content-type':'application/json','x-api-key':KEY,...headers},body:JSON.stringify({stageProfiles:testStages(),...data})});}
const envelope=(value=fixtureResult(),extra={})=>({id:'resp-synthetic',model:'deepseek-flash',status:'completed',usage:{input_tokens:1000,output_tokens:200},output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],...extra});
const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers});
async function call(data,apiResponse=envelope(),status=200){let calls=[];const r=await handleAPI(request(data),'grade',async(url,opts)=>{calls.push({url,opts});return response(apiResponse,status,{'x-request-id':'provider-id'});});return {r,data:await r.json(),calls};}

test('valid grade request uses independent scoped context and no tools/state',async()=>{const b=await body();const x=await call(b);assert.equal(x.r.status,200);assert.equal(x.calls.length,1);const {url,opts}=x.calls[0];assert.equal(url,'https://api.deepseek.com/responses');assert.equal(opts.redirect,'manual');assert.equal(opts.headers.authorization,`Bearer ${KEY}`);const sent=JSON.parse(opts.body);assert.equal(sent.store,undefined);assert.equal(sent.model,API_SETTINGS.model);assert.equal(sent.tools,undefined);assert.equal(sent.previous_response_id,undefined);assert.equal(sent.text.format.strict,true);assert.ok(!opts.body.includes('private-student-name'));assert.ok(!opts.body.includes(KEY));assert.equal(x.data.estimatedCny,0.00405);assert.equal(x.data.providerRequestId,'provider-id');assert.equal(x.r.headers.get('cache-control'),'no-store, max-age=0');});
test('unknown grading routing field is rejected before any API call',async()=>{const b=await body();b.lane='obsolete';const x=await call(b);assert.equal(x.r.status,422);assert.equal(x.data.code,'VALIDATION');assert.equal(x.calls.length,0);});
test('foreign origin blocked before external fetch',async()=>{let n=0;const r=await handleAPI(request(await body(),{origin:'https://evil.example'}),'grade',()=>{n++;});assert.equal(r.status,403);assert.equal(n,0);});
test('missing key and unsupported method do not send',async()=>{for(const req of [request(await body(),{'x-api-key':''}),new Request('https://grading.example/api/grade')]){let n=0;const r=await handleAPI(req,'grade',()=>{n++;});assert.ok(r.status>=400);assert.equal(n,0);}});
test('demo pack and extra secret field never reach external API',async()=>{for(const change of [b=>b.pack.demo=true,b=>b.apiKey='forbidden']){const b=await body();change(b);const x=await call(b);assert.ok(x.r.status>=400);assert.equal(x.calls.length,0);}});
test('unapproved pack unknown question and page ID are blocked',async()=>{for(const change of [b=>b.pack.approved_by='',b=>b.questionId='Q2',b=>b.pages[0].page_id='P9']){const b=await body();change(b);const x=await call(b);assert.ok(x.r.status>=400);assert.equal(x.calls.length,0);}});
test('changed hash or file format fails locally',async()=>{for(const change of [b=>b.pages[0].sha256='0'.repeat(64),b=>b.pages[0].mime='application/pdf']){const b=await body();change(b);const x=await call(b);assert.ok(x.r.status>=400);assert.equal(x.calls.length,0);}});
test('unrecognized answer files and malformed base64 blocked',async()=>{for(const change of [b=>b.pages[0].mime='text/plain',b=>b.pages[0].data='%%%%']){const b=await body();change(b);const x=await call(b);assert.ok(x.r.status>=400);assert.equal(x.calls.length,0);}});
test('request stream cap is independent of declared content length',async()=>{let n=0;const req=new Request('https://grading.example/api/grade',{method:'POST',headers:{origin:'https://grading.example','content-type':'application/json','x-api-key':KEY,'content-length':'1'},body:'a'.repeat(10*1024*1024+1)});const r=await handleAPI(req,'grade',()=>{n++;});assert.equal(r.status,413);assert.equal(n,0);});
test('incomplete response preserves usage and raw but no score',async()=>{const x=await call(await body(),envelope(undefined,{status:'incomplete'}));assert.equal(x.data.code,'INCOMPLETE');assert.equal(x.data.result,undefined);assert.equal(x.data.estimatedCny,0.00405);assert.ok(x.data.raw);});
test('refusal empty output and invalid JSON remain failures',async()=>{for(const [value,code] of [[envelope(undefined,{output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}),'REFUSAL'],[envelope(undefined,{output:[]}), 'EMPTY_OUTPUT'],[envelope(undefined,{output:[{type:'message',content:[{type:'output_text',text:'{broken'}]}]}),'INVALID_RESULT_JSON']]){const x=await call(await body(),value);assert.equal(x.data.code,code);assert.equal(x.data.result,undefined);assert.ok(x.data.usage);}});
test('invalid scoring semantics returns paid failure not zero',async()=>{const result=fixtureResult();result.criteria[0].awarded=99;const x=await call(await body(),envelope(result));assert.equal(x.data.code,'VALIDATION');assert.equal(x.data.estimatedCny,0.00405);assert.equal(x.data.result,undefined);});
test('successful unknown usage has null estimate',async()=>{const x=await call(await body(),envelope(undefined,{usage:undefined}));assert.equal(x.r.status,200);assert.equal(x.data.estimatedCny,null);assert.equal(x.data.usage,null);});
test('usage with bool negative or fractional counts is unknown',()=>{for(const u of [{input_tokens:true,output_tokens:0},{input_tokens:2.5,output_tokens:1},{input_tokens:-1,output_tokens:1}])assert.equal(estimateCny(u),null);});
test('long context includes higher rates and reasoning not added twice',()=>{assert.equal(estimateCny({input_tokens:300000,output_tokens:10000}),0.765);assert.equal(estimateCny({input_tokens:1000,output_tokens:200,reasoning_tokens:150}),0.00405);});
test('network uncertainty makes one request and has no leaked exception',async()=>{let n=0;const r=await handleAPI(request(await body()),'grade',async()=>{n++;throw Error(KEY);});const data=await r.json();assert.equal(n,1);assert.equal(data.uncertain,true);assert.ok(!JSON.stringify(data).includes(KEY));});
test('rate limit and quota are explicit and never auto retry',async()=>{for(const [code,expected] of [['rate_limit_exceeded','RATE_LIMIT'],['insufficient_quota','QUOTA']]){const x=await call(await body(),{error:{code}},429);assert.equal(x.calls.length,1);assert.equal(x.data.code,expected);assert.equal(x.data.uncertain,false);}});
test('authentication and upstream errors distinguished',async()=>{const auth=await call(await body(),{error:{message:KEY}},401);assert.equal(auth.data.code,'AUTH');assert.equal(auth.data.uncertain,false);assert.ok(!JSON.stringify(auth.data).includes(KEY));const upstream=await call(await body(),{error:{message:'bad'}},500);assert.equal(upstream.data.uncertain,true);});
test('upstream raw headers cannot leak arbitrary metadata',async()=>{const x=await call(await body(),envelope(undefined,{secret_echo:KEY}));assert.ok(!JSON.stringify(x.data).includes(KEY));assert.ok(x.data.raw.includes('[REDACTED]'));assert.equal(x.data.headers,undefined);});
test('oversized upstream body is uncertain and bounded',async()=>{const r=await handleAPI(request(await body()),'grade',async()=>new Response('a'.repeat(2*1024*1024+1)));const data=await r.json();assert.equal(data.code,'RESPONSE_TOO_LARGE');assert.equal(data.uncertain,true);});
test('prepare extracts draft with neutral names, warnings block readiness',async()=>{const documents=[];for(const role of ['paper','solution','rubric']){const f=await file();documents.push({role,sourceMime:f.mime,sourceSha256:f.sha256,files:[f]});};const p=fixturePack();p.approved_by='';for(const warnings of [[],['部分分政策尚未提供']]){let opts;const r=await handleAPI(request({documents,requestId:'prep-1'}, {},'https://grading.example/api/prepare'),'prepare',async(_url,o)=>{opts=o;return response(envelope({pack:p,warnings}));});const data=await r.json();assert.equal(r.status,200);assert.equal(data.ready,!warnings.length);assert.equal(data.pack.approved_by,'');assert.equal(data.documentHashes.paper,documents[0].sourceSha256);assert.ok(!opts.body.includes('private-student-name'));}});
test('prepare cannot invent approval and empty pack cannot proceed',async()=>{const documents=[];for(const role of ['paper','solution','rubric']){const f=await file();documents.push({role,sourceMime:f.mime,sourceSha256:f.sha256,files:[f]});};for(const p of [fixturePack(),{...fixturePack(),approved_by:'',questions:[]}]){const r=await handleAPI(request({documents,requestId:'prep-2'}),'prepare',async()=>response(envelope({pack:p,warnings:[]})));assert.equal(r.status,422);}});
async function prepareCall(value){
  const documents=[];
  for(const role of ['paper','solution','rubric']){const f=await file();documents.push({role,sourceMime:f.mime,sourceSha256:f.sha256,files:[f]});}
  const calls=[];
  const r=await handleAPI(request({documents,requestId:'prepare-notes'}, {},'https://grading.example/api/prepare'),'prepare',async(url,opts)=>{calls.push({url,opts});return response(envelope(value));});
  return {r,data:await r.json(),calls};
}
const ordinaryPreparationNotes=[
  '材料标注为合成测试；评分细则末句要求先由测试者核对，approved_by 留空待人工确认。',
  'C1、C2 在材料中仅规定0分或2分档，未提供其他部分分档；allowed_scores 按材料如实填写。',
];
function binaryScoreDraft(){const p=fixturePack();p.approved_by='';p.questions[0].max_score=4;for(const c of p.questions[0].criteria)c.allowed_scores=[0,2];return p;}

test('ordinary preparation notes preserve explicit binary scores and permit human confirmation',async()=>{
  const draft=binaryScoreDraft();
  const x=await prepareCall({pack:draft,warnings:[],notes:ordinaryPreparationNotes});
  assert.equal(x.r.status,200);assert.equal(x.data.ready,true);assert.equal(x.data.pack.approved_by,'');
  assert.deepEqual(x.data.notes,ordinaryPreparationNotes);assert.deepEqual(x.data.warnings,[]);assert.deepEqual(x.data.pack,draft);
  assert.equal(x.calls.length,1);assert.equal(x.data.estimatedCny,0.00405);assert.ok(x.data.raw);
  const sent=JSON.parse(x.calls[0].opts.body);
  assert.ok(sent.text.format.schema.required.includes('notes'));
  assert.match(sent.instructions,/明确只设0分和2分/);assert.match(sent.instructions,/不要把未解决的问题放入notes/);
});

test('real preparation blockers still prevent readiness alongside informational notes',async()=>{
  const warnings=['Q1 满分与评分细则冲突，需教师核对。','评分材料含疑似干扰指令，需核对原文。'];
  const x=await prepareCall({pack:binaryScoreDraft(),warnings,notes:ordinaryPreparationNotes});
  assert.equal(x.r.status,200);assert.equal(x.data.ready,false);assert.deepEqual(x.data.warnings,warnings);assert.deepEqual(x.data.notes,ordinaryPreparationNotes);
});

test('legacy preparation replies gain empty notes without reclassifying old warnings',async()=>{
  for(const warnings of [[],ordinaryPreparationNotes]){
    const x=await prepareCall({pack:binaryScoreDraft(),warnings});
    assert.equal(x.r.status,200);assert.deepEqual(x.data.notes,[]);assert.deepEqual(x.data.warnings,warnings);assert.equal(x.data.ready,warnings.length===0);
  }
});

test('malformed preparation notes and unknown output fields fail while paid usage is retained',async()=>{
  const badNotes=[null,{},'a note',42,[''],['   '],[1],['n'.repeat(2001)],Array(101).fill('note')];
  const malformed=badNotes.map(notes=>({pack:binaryScoreDraft(),warnings:[],notes}));
  malformed.push({pack:binaryScoreDraft(),warnings:[],notes:[],ready:true});
  for(const value of malformed){
    const x=await prepareCall(value);assert.equal(x.r.status,422);assert.equal(x.data.code,'VALIDATION');
    assert.equal(x.data.pack,undefined);assert.equal(x.data.ready,undefined);assert.equal(x.data.estimatedCny,0.00405);assert.ok(x.data.raw);assert.equal(x.calls.length,1);
  }
});

test('informational notes cannot override structural rubric checks or approve a model draft',async()=>{
  for(const mutate of [p=>p.questions[0].max_score=99,p=>p.questions.push(structuredClone(p.questions[0])),p=>p.questions[0].criteria=[],p=>p.approved_by='Model approved',p=>p.demo=true]){
    const draft=binaryScoreDraft();mutate(draft);
    const x=await prepareCall({pack:draft,warnings:[],notes:['已核对，可使用。']});
    assert.equal(x.r.status,422);assert.equal(x.data.code,'VALIDATION');assert.equal(x.data.pack,undefined);assert.equal(x.data.ready,undefined);assert.equal(x.data.estimatedCny,0.00405);
  }
});

test('strict schemas mark all object keys required and forbid extra fields',()=>{function check(s){if(s.type==='object'){assert.equal(s.additionalProperties,false);assert.deepEqual([...s.required].sort(),Object.keys(s.properties).sort());Object.values(s.properties).forEach(check);}if(s.items)check(s.items);}check(PACK_SCHEMA);check(RESULT_SCHEMA);check(IDENTITY_SCHEMA);});

test('single file and combined decoded byte caps reject before upstream send',async()=>{
  let b=await body();b.pages[0].data='A'.repeat(4*Math.ceil((3*1024*1024+1)/3));
  let x=await call(b);assert.ok(x.r.status>=400);assert.equal(x.calls.length,0);assert.equal(x.data.uncertain,false);
  b=await body();const page=b.pages[0];b.pages=[1,2,3].map(i=>({...page,page_id:'P'+i,data:'A'.repeat(4*Math.ceil((2*1024*1024+1)/3))}));
  x=await call(b);assert.equal(x.data.code,'FILES_TOO_LARGE');assert.equal(x.calls.length,0);
});
test('four requests run concurrently while a fifth is rejected without an upstream charge',async()=>{
  let sendCount=0,release;const gate=new Promise(resolve=>{release=resolve;});
  let ready;const started=new Promise(resolve=>{ready=resolve;});
  const transport=async()=>{sendCount++;if(sendCount===4)ready();await gate;return response(envelope());};
  const requests=[];for(let i=0;i<4;i++){const b=await body();b.requestId='concurrent-'+i;requests.push(handleAPI(request(b),'grade',transport));}
  await started;
  const busy=await handleAPI(request(await body()),'grade',transport);const data=await busy.json();
  assert.equal(busy.status,429);assert.equal(data.code,'SERVER_BUSY');assert.equal(data.uncertain,false);assert.equal(data.estimatedCny,0);assert.equal(sendCount,4);
  release();assert.deepEqual((await Promise.all(requests)).map(r=>r.status),[200,200,200,200]);
  assert.equal((await call(await body())).r.status,200);
});
test('failed requests release all four server slots without retaining request state',async()=>{
  let ready;const started=new Promise(resolve=>{ready=resolve;});let rejectRequests;const gate=new Promise((_resolve,reject)=>{rejectRequests=reject;});let calls=0;
  const transport=async()=>{calls++;if(calls===4)ready();return gate;};
  const requests=[];for(let i=0;i<4;i++){const b=await body();b.requestId='failure-'+i;requests.push(handleAPI(request(b),'grade',transport));}
  await started;rejectRequests(Error('simulated network failure'));
  const results=await Promise.all(requests.map(async r=>(await r).json()));
  assert.ok(results.every(r=>r.uncertain===true&&r.code==='NETWORK'));assert.equal(calls,4);
  assert.equal((await call(await body())).r.status,200);
});
test('caller-provided provider URL cannot redirect keys to another host',async()=>{
  const b=await body();b.endpoint='https://attacker.example/collect';const x=await call(b);
  assert.equal(x.calls.length,0);assert.equal(x.data.code,'VALIDATION');
});

test('Workers-compatible fetch blocks redirects without forwarding keys or adopting a score',async()=>{
  for(const provider of ['deepseek'])for(const status of [301,302,303,307,308]){
    let calls=0;
    const r=await handleAPI(request(await body(),{'x-api-provider':provider}),'grade',async(url,options)=>{
      calls++;
      // Workers throws before sending when redirect:error is used.
      if(options.redirect==='error')throw new TypeError('Invalid redirect value');
      assert.equal(options.redirect,'manual');
      assert.equal(new URL(url).hostname,'api.deepseek.com');
      return response(envelope(),status,{location:'https://untrusted.example/collect'});
    });
    const data=await r.json();
    assert.equal(calls,1);assert.equal(r.status,502);assert.equal(data.code,'UPSTREAM_REDIRECT');
    assert.equal(data.uncertain,true);assert.equal(data.estimatedCny,null);assert.equal(data.result,undefined);
    assert.ok(!JSON.stringify(data).includes(KEY));assert.ok(!JSON.stringify(data).includes('untrusted.example'));
  }
});

test('question-specific output schema binds each allowed score to its own criterion and evidence',async()=>{
  const b=await body();b.questionId='Q8';const q=b.pack.questions[0];q.question_id='Q8';
  q.criteria[0].allowed_scores=[0,2,4];q.criteria[1].criterion_id='C4';q.criteria[1].allowed_scores=[0,1];
  const bad=fixtureResult();bad.question_id='Q8';bad.criteria[0].awarded=4;bad.criteria[1].criterion_id='C4';bad.criteria[1].awarded=2;
  const x=await call(b,envelope(bad));
  const schema=JSON.parse(x.calls[0].opts.body).text.format.schema;
  assert.deepEqual(schema.properties.question_id.enum,['Q8']);
  const branches=schema.properties.criteria.items.anyOf;
  assert.equal(branches.length,2);
  const c4=branches.find(s=>s.properties.criterion_id.enum.includes('C4'));
  assert.deepEqual(c4.properties.awarded.enum,[0,1,null]);
  assert.deepEqual(c4.properties.evidence_refs.items.enum,['P1']);
  assert.ok(!branches.some(s=>s.properties.criterion_id.enum.includes('C4')&&s.properties.awarded.enum.includes(2)));
  assert.equal(x.data.code,'VALIDATION');assert.equal(x.data.result,undefined);assert.equal(x.data.estimatedCny,0.00405);
  assert.match(x.data.error,/Q8 \/ C4返回2分/);assert.match(x.data.error,/允许档位为0、1分/);assert.ok(x.data.raw);
  for(const s of branches){assert.equal(s.additionalProperties,false);assert.deepEqual([...s.required].sort(),Object.keys(s.properties).sort());}
});

const fixtureIdentity=()=>({name:'合成姓名',student_id:'001234',name_status:'readable',student_id_status:'readable',warnings:[]});
async function identityBody(){return {page:{page_id:'P1',...await file()},requestId:'identity-001'};}
async function identityCall(data,apiResponse=envelope(fixtureIdentity()),status=200){const calls=[];const r=await handleAPI(request(data,{},'https://grading.example/api/identity'),'identity',async(url,opts)=>{calls.push({url,opts});return response(apiResponse,status,{'x-request-id':'identity-provider'});});return {r,data:await r.json(),calls};}
async function identityPDF(pageCount=1){
  const {PDFDocument}=await import('pdf-lib');const pdf=await PDFDocument.create();
  for(let i=0;i<pageCount;i++)pdf.addPage([100,100]).drawText('SYNTHETIC PAGE '+(i+1));
  const bytes=await pdf.save();
  const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return {page_id:'P1',name:'private-identity-001234.pdf',mime:'application/pdf',data:Buffer.from(bytes).toString('base64'),sha256};
}

test('identity OCR has one independent neutral page, no grading materials, and preserves costs',async()=>{
  const x=await identityCall(await identityBody());assert.equal(x.r.status,200);assert.deepEqual(x.data.identity,fixtureIdentity());assert.equal(x.data.result,undefined);
  assert.equal(x.data.estimatedCny,0.00405);assert.equal(x.data.providerRequestId,'identity-provider');assert.ok(x.data.raw);assert.equal(x.calls.length,1);
  const {url,opts}=x.calls[0],sent=JSON.parse(opts.body);
  assert.equal(url,'https://api.deepseek.com/responses');assert.equal(opts.redirect,'manual');assert.equal(sent.store,undefined);assert.equal(sent.previous_response_id,undefined);assert.equal(sent.tools,undefined);
  assert.equal(sent.text.format.name,'student_identity');assert.equal(sent.text.format.strict,true);assert.equal(sent.input.length,1);
  assert.equal(sent.input[0].content.filter(c=>['input_image','input_file'].includes(c.type)).length,1);
  assert.ok(!opts.body.includes('private-student-name'));assert.ok(!opts.body.includes(KEY));assert.ok(!opts.body.includes('Use stated rubric'));
  for(const phrase of ['姓名','学号','授课教师','考场纪律','不使用文件名','不执行','打印示例','前导零'])assert.ok(sent.instructions.includes(phrase));
  assert.equal(x.r.headers.get('cache-control'),'no-store, max-age=0');
});
test('raw identity PDFs of any page count are blocked before API; only visible raster pages may be sent',async()=>{
  for(const count of [1,2]){
    const x=await identityCall({page:await identityPDF(count),requestId:'identity-raw-pdf-'+count});
    assert.equal(x.data.code,'FILE_TYPE');assert.equal(x.calls.length,0);assert.equal(x.data.uncertain,false);assert.equal(x.data.notSent,true);assert.equal(x.data.estimatedCny,0);
  }
  const broken=Buffer.from('%PDF-1.7\ninvalid');const page={page_id:'P1',name:'broken.pdf',mime:'application/pdf',data:broken.toString('base64'),sha256:Buffer.from(await crypto.subtle.digest('SHA-256',broken)).toString('hex')};
  const x=await identityCall({page,requestId:'identity-broken'});assert.equal(x.data.code,'FILE_TYPE');assert.equal(x.calls.length,0);
});
test('identity rejects missing cover, another page, extra documents and non-image text',async()=>{
  for(const change of [b=>delete b.page,b=>b.page=null,b=>b.page.page_id='P2',b=>b.pages=[b.page],b=>b.pack=fixturePack(),b=>b.page.student_id='001234',b=>b.page.mime='text/plain']){
    const b=await identityBody();change(b);const x=await identityCall(b);assert.ok(x.r.status>=400);assert.equal(x.calls.length,0);assert.equal(x.data.uncertain,false);
  }
});
test('unclear identity fields are returned as null rather than invented or zero',async()=>{
  for(const [field,status] of [['name','unreadable'],['student_id','blank']]){
    const id=fixtureIdentity();id[field]=null;id[field+'_status']=status;id.warnings=['合成模糊栏'];
    const x=await identityCall(await identityBody(),envelope(id));assert.equal(x.r.status,200);assert.equal(x.data.identity[field],null);
  }
});
test('invalid identity response is a paid validation failure without usable identity',async()=>{
  for(const change of [r=>r.student_id=1234,r=>r.name_status='unreadable',r=>r.name=null,r=>r.score=10]){
    const id=fixtureIdentity();change(id);const x=await identityCall(await identityBody(),envelope(id));assert.equal(x.data.code,'VALIDATION');assert.equal(x.data.identity,undefined);assert.equal(x.data.estimatedCny,0.00405);
  }
});
test('identity failures retain uncertainty and redact keys without retries or logs',async()=>{
  let calls=0;const output=[],oldLog=console.log,oldError=console.error;
  console.log=(...a)=>output.push(a);console.error=(...a)=>output.push(a);
  try{
    const r=await handleAPI(request(await identityBody()),'identity',async()=>{calls++;throw Error(KEY);});const data=await r.json();assert.equal(calls,1);assert.equal(data.uncertain,true);assert.equal(data.code,'NETWORK');assert.ok(!JSON.stringify(data).includes(KEY));assert.deepEqual(output,[]);
  }finally{console.log=oldLog;console.error=oldError;}
  const x=await identityCall(await identityBody(),{error:{message:KEY}},401);assert.equal(x.data.code,'AUTH');assert.equal(x.data.uncertain,false);assert.ok(!JSON.stringify(x.data).includes(KEY));
});
test('identity transcription never carries into a later grade request',async()=>{
  const identity=fixtureIdentity();identity.name='SYNTHETIC-PRIVATE-NAME';identity.student_id='00987654321';
  assert.equal((await identityCall(await identityBody(),envelope(identity))).r.status,200);
  const grade=await call(await body());const wire=grade.calls[0].opts.body;
  assert.ok(!wire.includes(identity.name));assert.ok(!wire.includes(identity.student_id));assert.ok(!wire.includes('student_identity'));
});
