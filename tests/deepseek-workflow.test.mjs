import test from 'node:test';
import assert from 'node:assert/strict';
import {handleAPI} from '../lib/grading/api-service.mjs';
import {createStudentPDFJob as createDefaultStudentPDFJob,runJob,snapshotJob,importBackup,rebindJob,hashJSON,resolveStudentIdentity,prepareTeachingMaterials,readProviderFiles,restorePreparationDraft,attachPreparation} from '../lib/grading/browser-workflow.mjs';
import {fixturePack,fixtureResult,fixtureIdentity,envelope,syntheticPDF,renderPDF,imageInfo} from './helpers/pdf-rendering.mjs';
import {getDefaultProfile,DEFAULT_STAGE_PROFILES} from '../lib/grading/providers.mjs';
const createStudentPDFJob=(p,f,s={},r)=>createDefaultStudentPDFJob(p,f,{reviewProfile:null,...s},r);
const locks={request:async(_name,_options,fn)=>fn({name:'synthetic-lock'})};
const options=extra=>({apiKey:'synthetic-key-never-persist',locks,load:async()=>null,persist:async()=>{},isOnline:()=>true,renderPDF,...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function until(condition){for(let i=0;i<15000;i++){if(condition())return;await tick();}throw Error('Synthetic condition was not reached');}
async function readyJob(count=2,settings={}){
  const file=new File([await syntheticPDF(count+1)],'900000001.pdf',{type:'application/pdf'});
  const job=await createStudentPDFJob(fixturePack(count),[file],{provider:'deepseek',...settings});return {job,file};
}

test('DeepSeek end-to-end: real PDF images, isolated identity, scoped grades, durable hashes, fees and resume',async()=>{
  const {job,file}=await readyJob();const upstream=[],browserCalls=[];let durable;
  const fetcher=async(url,requestOptions)=>{
    const body=JSON.parse(requestOptions.body);browserCalls.push({url,body});assert.equal(requestOptions.headers['X-Api-Provider'],'deepseek');
    const kind=url.split('/').at(-1),item=kind==='identity'?durable.documents[0]:durable.tasks.find(t=>t.questionId===body.questionId);
    const attempt=item.attempts.find(a=>a.id===body.requestId);assert.equal(attempt.state,'in_flight');
    const upload=kind==='identity'?body.page:body.pages[0];assert.equal(upload.mime,'image/jpeg');assert.equal(attempt.inputs[0].sha256,upload.sha256);assert.notEqual(attempt.inputs[0].sourceSha256,upload.sha256);
    const {center}=await imageInfo(new File([Buffer.from(upload.data,'base64')],'page.jpg',{type:'image/jpeg'}));
    const color=kind==='identity'?0:Number(body.questionId.slice(1));assert.ok(center[color]>250&&center[(color+1)%3]<5);
    const request=new Request('https://grading.example'+url,{method:'POST',headers:{...requestOptions.headers,origin:'https://grading.example'},body:requestOptions.body});
    return handleAPI(request,kind,async(endpoint,upstreamOptions)=>{
      const sent=JSON.parse(upstreamOptions.body);upstream.push({endpoint,sent});assert.equal(endpoint,'https://api.deepseek.com/responses');
      assert.equal(sent.reasoning.effort,'max');assert.equal(sent.max_output_tokens,16000);
      assert.equal(durable.settings.reasoning,'max');assert.equal(durable.settings.outputTokens,16000);
      assert.ok(sent.input[0].content.some(c=>c.type==='input_image'));assert.ok(!sent.input[0].content.some(c=>c.type==='input_file'));
      return new Response(JSON.stringify(envelope(kind==='identity'?fixtureIdentity():fixtureResult(body.questionId))),{headers:{'content-type':'application/json'}});
    });
  };
  const out=await runJob(job,options({fetcher,persist:async current=>{durable=snapshotJob(current);}}));
  assert.equal(out.requests,3);assert.equal(browserCalls[0].url,'/api/identity');assert.equal(upstream.length,3);
  assert.ok(job.tasks.every(t=>t.state==='done'));assert.equal(job.heldCny,0);assert.ok(Math.abs(job.spentCny-0.0088425)<1e-9);
  const saved=snapshotJob(job);assert.equal(saved.formatVersion,3);assert.ok(!JSON.stringify(saved).includes('synthetic-key-never-persist'));
  assert.deepEqual(saved.documents[0].attempts[0].response.requestSettings,{reasoning:'max',outputTokens:16000});
  assert.deepEqual(saved.tasks[0].attempts[0].response.requestSettings,{reasoning:'max',outputTokens:16000});
  assert.ok(!JSON.stringify(upstream.slice(1)).includes('900000001'));assert.ok(!JSON.stringify(upstream.slice(1)).includes('姓名栏'));
  const restored=await importBackup(saved);await rebindJob(restored,[file],{load:async()=>null});
  const resumed=await runJob(restored,options({fetcher:()=>{throw Error('must reuse paid results');}}));assert.equal(resumed.requests,0);
  for(const mutate of [s=>s.tasks[0].attempts[0].inputs[0].sourceSha256='0'.repeat(64),s=>s.tasks[0].attempts[0].provider='openai',s=>delete s.tasks[0].attempts[0].inputs]){
    const changed=structuredClone(saved);mutate(changed);await assert.rejects(()=>importBackup(changed),/证据|服务商|校验记录/);
  }
  const changed=structuredClone(saved);changed.settings.provider='openai';changed.settingsHash=await hashJSON(changed.settings);await assert.rejects(()=>importBackup(changed),/服务商|阶段模型/);
});
test('DeepSeek grading settings survive backups and reject old or altered profiles without conversion',async()=>{
  const {job}=await readyJob(1),saved=snapshotJob(job);
  assert.equal(saved.settings.reasoning,'max');assert.equal(saved.settings.outputTokens,16000);
  assert.equal(saved.settingsHash,await hashJSON(saved.settings));
  const restored=await importBackup(saved);assert.deepEqual(restored.settings,saved.settings);
  for(const profile of [{reasoning:'high',outputTokens:8000},{reasoning:'max',outputTokens:8000},{reasoning:'max',outputTokens:32000}]){
    const changed=structuredClone(saved);Object.assign(changed.settings,profile);changed.settingsHash=await hashJSON(changed.settings);
    await assert.rejects(()=>importBackup(changed),/推理设置.*旧批次不会转换/);
    let calls=0;
    await assert.rejects(()=>runJob({...job,...changed},options({fetcher:()=>{calls++;}})),/推理设置/);
    assert.equal(calls,0);
  }
  const file=new File([await syntheticPDF(2)],'900000001.pdf',{type:'application/pdf'});
  const qwen=await createStudentPDFJob(fixturePack(),[file],{provider:'qwen'});
  assert.equal(qwen.settings.reasoning,'max');assert.equal(qwen.settings.outputTokens,16000);
  assert.deepEqual((await importBackup(snapshotJob(qwen))).settings,qwen.settings);
});
test('DeepSeek conversion failure cannot reserve fees or call the API',async()=>{
  const {job}=await readyJob();let calls=0;
  await assert.rejects(()=>runJob(job,options({renderPDF:async()=>{throw Error('synthetic render failure');},fetcher:()=>calls++})),/render failure/);
  assert.equal(calls,0);assert.equal(job.heldCny,0);assert.equal(job.documents[0].attempts.length,0);assert.ok(job.tasks.every(t=>!t.result));
});

test('visible progress covers local conversion before the request and waiting for each response',async()=>{
  const {job}=await readyJob(1,{concurrency:1});const progress=[];
  const out=await runJob(job,options({onProgress:p=>progress.push(p),fetcher:async(url,opts)=>{
    const kind=url.endsWith('/identity')?'identity':'grade';
    assert.ok(progress.some(p=>p.kind===kind&&p.phase==='reading'));
    assert.equal(progress.at(-1).kind,kind);assert.equal(progress.at(-1).phase,'waiting');
    const body=JSON.parse(opts.body);
    return new Response(JSON.stringify({provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,estimatedCny:.01,...(kind==='identity'?{identity:fixtureIdentity()}:{result:fixtureResult(body.questionId)})}));
  }}));
  assert.equal(out.requests,2);assert.equal(job.heldCny,0);
  assert.deepEqual(progress.map(p=>[p.phase,p.kind,p.questionId]),[['reading','identity',null],['waiting','identity',null],['reading','grade','Q1'],['waiting','grade','Q1']]);
  await importBackup(snapshotJob(job));
});
test('unknown DeepSeek fees pause before grading and preserve the successful identity and reserve',async()=>{
  const {job}=await readyJob(2,{concurrency:1});let calls=0;
  const out=await runJob(job,options({fetcher:async()=>{calls++;return new Response(JSON.stringify({provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,identity:fixtureIdentity(),estimatedCny:null,usage:null}),{status:200});}}));
  assert.equal(out.paused,true);assert.equal(calls,1);assert.equal(job.documents[0].identityState,'done');assert.equal(job.heldCny,5);assert.ok(job.tasks.every(t=>t.state==='ready'));
  await importBackup(snapshotJob(job));
});
test('DeepSeek still runs at most four requests and saves reversed completions sequentially', {timeout:20000},async()=>{
  const {job}=await readyJob(6);resolveStudentIdentity(job,job.documents[0].id,{studentId:'900000001',name:''});
  const calls=[];let active=0,peak=0,writes=0,peakWrites=0,durable;
  const persist=async current=>{writes++;peakWrites=Math.max(peakWrites,writes);await tick();durable=snapshotJob(current);writes--;};
  const fetcher=async(url,opts)=>{
    assert.equal(url,'/api/grade');const body=JSON.parse(opts.body);assert.ok(durable.tasks.some(t=>t.attempts.some(a=>a.id===body.requestId&&a.inputs[0].sha256===body.pages[0].sha256)));
    const gate=deferred();calls.push({body,...gate});active++;peak=Math.max(peak,active);try{return await gate.promise;}finally{active--;}
  };
  const running=runJob(job,options({fetcher,persist}));await until(()=>calls.length===4);assert.equal(active,4);
  const result=c=>new Response(JSON.stringify({provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,result:fixtureResult(c.body.questionId),estimatedCny:.01}));
  calls[2].resolve(result(calls[2]));await until(()=>calls.length===5);calls[0].resolve(result(calls[0]));await until(()=>calls.length===6);
  for(const i of [5,4,3,1])calls[i].resolve(result(calls[i]));
  const out=await running;assert.equal(out.requests,6);assert.equal(peak,4);assert.equal(peakWrites,1);assert.equal(job.heldCny,0);assert.ok(job.tasks.every(t=>t.result));await importBackup(durable);
});
test('a returned provider mismatch is unpriced, pauses and cannot become a score',async()=>{
  const {job}=await readyJob(1);resolveStudentIdentity(job,job.documents[0].id,{studentId:'900000001',name:''});
  const out=await runJob(job,options({fetcher:async()=>new Response(JSON.stringify({provider:'openai',estimatedCny:.001,result:fixtureResult()}))}));
  assert.equal(out.paused,true);assert.equal(job.tasks[0].result,null);assert.equal(job.heldCny,5);assert.equal(job.tasks[0].state,'uncertain');
});
test('DeepSeek material conversion is loss-explicit and records derived-image provenance before preparation',async()=>{
  const docx=new File([new Uint8Array([80,75,3,4])],'rubric.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  await assert.rejects(()=>readProviderFiles(docx,'deepseek'),/另存为PDF/);
  const file=new File([await syntheticPDF(1)],'material.pdf',{type:'application/pdf'});
  await assert.rejects(()=>readProviderFiles(file,'deepseek',{expectedHash:'0'.repeat(64),renderPDF}),/原文件内容已改变/);
  const prepared=await prepareTeachingMaterials({paper:file,solution:file,rubric:file},'deepseek',{renderPDF});
  const draft=fixturePack();draft.approved_by='';const attempt={id:'synthetic-prepare',kind:'prepare',provider:'deepseek',stageProfile:getDefaultProfile('deepseek','prepare'),inputs:prepared.inputs,documentHashes:prepared.documentHashes,state:'done',reservedCny:5,costCny:.01,response:{provider:'deepseek',stageProfile:getDefaultProfile('deepseek','prepare'),pack:draft,warnings:[],estimatedCny:.01,documentHashes:prepared.documentHashes}};
  assert.ok(restorePreparationDraft([attempt],{provider:'deepseek',documentHashes:prepared.documentHashes}));assert.equal(restorePreparationDraft([attempt],{provider:'openai'}),null);
  const {job}=await readyJob(1,{stageProfiles:{...structuredClone(DEFAULT_STAGE_PROFILES),prepare:getDefaultProfile('deepseek','prepare')}});attachPreparation(job,[attempt]);assert.equal(job.spentCny,.01);await importBackup(snapshotJob(job));
  const mismatch=structuredClone(attempt);mismatch.inputs[0].sourceSha256='0'.repeat(64);assert.throws(()=>attachPreparation(job,[mismatch]),/原件与发送记录/);
  for(const mutate of [a=>a.inputs.pop(),a=>a.inputs[0].page_id='P2',a=>a.inputs[0].mime='application/pdf',a=>a.inputs[0].sha256=[a.inputs[0].sha256]]){
    const invalid=structuredClone(attempt);mutate(invalid);assert.throws(()=>attachPreparation(job,[invalid]),/材料|PDF|校验|页序/);
  }
});
