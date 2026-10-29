import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAPI,estimateCny} from '../lib/grading/api-service.mjs';
import {getProvider,normalizeUsage,pricingMetadata} from '../lib/grading/providers.mjs';
import {readUpload,prepareTeachingMaterials} from '../lib/grading/browser-workflow.mjs';
import {fixturePack,fixtureResult,fixtureIdentity,envelope,syntheticPDF,renderPDF} from './helpers/pdf-rendering.mjs';
const KEY='synthetic-deepseek-key-no-live-request';
const png=new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'private-student-name.png',{type:'image/png'});
async function page(){return {page_id:'P1',...await readUpload(png)};}
function request(action,body,provider='deepseek'){return new Request('https://grading.example/api/'+action,{method:'POST',headers:{origin:'https://grading.example','content-type':'application/json','x-api-provider':provider,'x-api-key':KEY},body:JSON.stringify(body)});}
async function call(action,body,result=fixtureResult(),usage,provider='deepseek'){
  const calls=[];const response=await handleAPI(request(action,body,provider),action,async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(envelope(result,usage)),{headers:{'content-type':'application/json'}});});
  return {response,data:await response.json(),calls};
}
const gradeBody=async()=>({requestId:'synthetic-grade',pack:fixturePack(),questionId:'Q1',pages:[await page()]});

test('DeepSeek uses its fixed official Responses endpoint, model and independent image context',async()=>{
  const x=await call('grade',await gradeBody());assert.equal(x.response.status,200);assert.equal(x.calls.length,1);
  const {url,options}=x.calls[0],payload=JSON.parse(options.body);
  assert.equal(url,'https://api.deepseek.com/responses');assert.equal(options.redirect,'manual');assert.equal(options.headers.authorization,'Bearer '+KEY);
  assert.equal(payload.model,'deepseek-flash');assert.equal(payload.reasoning.effort,'max');assert.equal(payload.max_output_tokens,16000);assert.equal(payload.text.format.strict,true);
  assert.deepEqual(x.data.requestSettings,{reasoning:'max',outputTokens:16000});
  assert.equal(payload.input[0].content[1].type,'input_image');assert.equal(payload.tools,undefined);assert.equal(payload.previous_response_id,undefined);
  assert.ok(!options.body.includes('private-student-name'));assert.ok(!options.body.includes(KEY));
  assert.equal(x.data.provider,'deepseek');assert.equal(x.data.estimatedCny,0.0029475);assert.equal(x.data.pricing.basis,'peak-rate-ceiling');
});
test('DeepSeek identity accepts one anonymous image without any grading rules',async()=>{
  const x=await call('identity',{requestId:'synthetic-identity',page:await page()},fixtureIdentity());
  assert.equal(x.response.status,200);const payload=JSON.parse(x.calls[0].options.body);
  assert.equal(payload.reasoning.effort,'high');assert.equal(payload.max_output_tokens,8000);
  assert.deepEqual(x.data.requestSettings,{reasoning:'high',outputTokens:8000});
  assert.equal(payload.text.format.name,'student_identity');assert.ok(!JSON.stringify(payload).includes('Synthetic question'));assert.equal(x.data.identity.student_id,'900000001');
});
test('OpenAI keeps medium reasoning and 8000 tokens for grading, identity and preparation',async()=>{
  const file=await readUpload(png),pack=fixturePack();pack.approved_by='';
  const cases=[
    ['grade',await gradeBody(),fixtureResult()],
    ['identity',{requestId:'openai-identity',page:await page()},fixtureIdentity()],
    ['prepare',{requestId:'openai-prepare',documents:['paper','solution','rubric'].map(role=>({role,...file}))},{pack,warnings:[]}],
  ];
  for(const [action,body,result] of cases){
    const x=await call(action,body,result,undefined,'openai');assert.equal(x.response.status,200);
    const payload=JSON.parse(x.calls[0].options.body);
    assert.equal(payload.model,'gpt-6.1-terra');assert.equal(payload.reasoning.effort,'medium');assert.equal(payload.max_output_tokens,8000);
  }
});
test('raw PDF or Word input is blocked locally for DeepSeek, including identity and grading',async()=>{
  const pdf=new File([await syntheticPDF(1)],'single.pdf',{type:'application/pdf'}),upload={...await readUpload(pdf),page_id:'P1'};
  for(const action of ['grade','identity']){
    const body=action==='grade'?{...await gradeBody(),pages:[upload]}:{requestId:'synthetic-pdf',page:upload};
    const x=await call(action,body);assert.equal(x.data.code,'FILE_TYPE');assert.equal(x.calls.length,0);assert.equal(x.data.uncertain,false);
  }
});
test('DeepSeek teaching PDFs become ordered image groups, preserving source hashes and role boundaries',async()=>{
  const pdf=new File([await syntheticPDF(2)],'teacher.pdf',{type:'application/pdf'});
  const prepared=await prepareTeachingMaterials({paper:pdf,solution:png,rubric:png},'deepseek',{renderPDF});
  const pack=fixturePack();pack.approved_by='';const x=await call('prepare',{requestId:'synthetic-prepare',documents:prepared.documents},{pack,warnings:[]});
  assert.equal(x.response.status,200);assert.equal(x.data.ready,true);assert.deepEqual(x.data.documentHashes,prepared.documentHashes);
  const payload=JSON.parse(x.calls[0].options.body),content=payload.input[0].content;
  assert.equal(payload.reasoning.effort,'high');assert.equal(payload.max_output_tokens,8000);
  assert.equal(content.filter(p=>p.type==='input_image').length,4);assert.equal(content.filter(p=>p.type==='input_file').length,0);
  assert.ok(!JSON.stringify(content).includes('teacher.pdf'));
});
test('DeepSeek preserves text teacher materials and rejects unknown providers or custom URLs before send',async()=>{
  const text=new File(['Synthetic UTF-8 rubric'],'rubric.txt',{type:'text/plain'});
  const prepared=await prepareTeachingMaterials({paper:text,solution:text,rubric:text},'deepseek');
  const pack=fixturePack();pack.approved_by='';const x=await call('prepare',{requestId:'text-prepare',documents:prepared.documents},{pack,warnings:[]});
  assert.equal(x.response.status,200);assert.equal(JSON.parse(x.calls[0].options.body).input[0].content.filter(p=>p.type==='input_text').length,9);
  for(const provider of ['__proto__','https://evil.example','unknown']){
    const bad=await call('grade',await gradeBody(),undefined,undefined,provider);assert.equal(bad.calls.length,0);assert.equal(bad.data.code,'PROVIDER');
    assert.throws(()=>getProvider(provider));
  }
  const bad=await call('grade',{...await gradeBody(),base_url:'https://evil.example'});assert.equal(bad.calls.length,0);
});
test('DeepSeek validates derived image hashes and the combined decoded size before billing',async()=>{
  const source=await readUpload(png),doc={role:'paper',sourceMime:'application/pdf',sourceSha256:'a'.repeat(64),files:[source]};
  const documents=['paper','solution','rubric'].map(role=>({...doc,role}));
  documents[0].files=[{...source,sha256:'0'.repeat(64)}];
  let x=await call('prepare',{requestId:'invalid-hash',documents});assert.equal(x.calls.length,0);assert.equal(x.data.code,'FILE_CHANGED');
  const huge='A'.repeat(4*Math.ceil((2*1024*1024+1)/3));
  documents.forEach(d=>d.files=[{...source,data:huge}]);
  x=await call('prepare',{requestId:'too-large',documents});assert.equal(x.calls.length,0);assert.equal(x.data.code,'FILES_TOO_LARGE');
});
test('DeepSeek fees use peak rates, valid cached tokens and count reasoning output only once',()=>{
  assert.equal(estimateCny({input_tokens:1_000_000,output_tokens:0},'deepseek'),2.25);
  assert.equal(estimateCny({input_tokens:1_000_000,output_tokens:0,input_tokens_details:{cached_tokens:1_000_000}},'deepseek'),0.045);
  assert.equal(estimateCny({input_tokens:0,output_tokens:1_000_000,output_tokens_details:{reasoning_tokens:900_000}},'deepseek'),9);
  assert.equal(estimateCny({input_tokens:1000,output_tokens:200},'deepseek'),0.00405);
  assert.equal(pricingMetadata('deepseek',{}).cacheUsage,'uncached-ceiling');
  for(const cached_tokens of [-1,1001,1.5,true,'500']){
    const u={input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens}};
    assert.equal(normalizeUsage(u),null);assert.equal(estimateCny(u,'deepseek'),null);
  }
});
test('DeepSeek invalid usage remains unpriced while valid results and raw response survive',async()=>{
  const x=await call('grade',await gradeBody(),fixtureResult(),{input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:1001}});
  assert.equal(x.response.status,200);assert.equal(x.data.estimatedCny,null);assert.equal(x.data.usage,null);assert.ok(x.data.result);assert.ok(x.data.raw);
});
test('DeepSeek service errors are not retried and keys are redacted',async()=>{
  let calls=0;const response=await handleAPI(request('grade',await gradeBody()),'grade',async()=>{calls++;return new Response(JSON.stringify({error:{message:KEY}}),{status:500});});
  const data=await response.json();assert.equal(calls,1);assert.equal(data.uncertain,true);assert.equal(data.code,'UPSTREAM');assert.ok(!JSON.stringify(data).includes(KEY));
});
test('DeepSeek grading that exhausts its token limit preserves fees without a score or retry',async()=>{
  let calls=0;
  const response=await handleAPI(request('grade',await gradeBody()),'grade',async(_url,options)=>{
    calls++;const payload=JSON.parse(options.body);
    assert.equal(payload.reasoning.effort,'max');assert.equal(payload.max_output_tokens,16000);
    return new Response(JSON.stringify({...envelope(fixtureResult(),{input_tokens:1000,output_tokens:16000,output_tokens_details:{reasoning_tokens:15900}}),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}}));
  });
  const data=await response.json();
  assert.equal(response.status,422);assert.equal(calls,1);assert.equal(data.code,'INCOMPLETE');assert.equal(data.result,undefined);
  assert.equal(data.estimatedCny,0.14625);assert.ok(data.raw);assert.equal(data.uncertain,false);
});
