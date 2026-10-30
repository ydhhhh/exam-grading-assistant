import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_STAGE_PROFILES,getDefaultProfile} from '../lib/grading/providers.mjs';
import {createStudentPDFJob,prepareTeachingMaterials,attachPreparation,restoreSessionBackup,runJob,taskAdvice,snapshotJob,importBackup,rebindJob,hashJSON,restorePreparationDraft} from '../lib/grading/browser-workflow.mjs';
import {fixturePack,fixtureResult,fixtureIdentity,syntheticPDF,renderPDF} from './helpers/pdf-rendering.mjs';
const clone=value=>structuredClone(value);
const locks={request:async(_name,_options,fn)=>fn({})};
const keys={prepare:'prepare-key-synthetic-only',grade:'grade-key-synthetic-only',review:'review-key-synthetic-only'};
const options={stageKeys:keys,renderPDF,locks,persist:async()=>{},load:async()=>null,isOnline:()=>true};
async function sample(settings={}){
  const file=new File([await syntheticPDF(2)],'900000001.pdf',{type:'application/pdf'});
  return {file,job:await createStudentPDFJob(fixturePack(),[file],settings)};
}
function answer(kind,body,extra={}){
  const stage=kind==='review'?'review':'grade',profile=body.stageProfiles[stage];
  return new Response(JSON.stringify({provider:profile.provider,stageProfile:profile,stageProfiles:body.stageProfiles,requestId:body.requestId,estimatedCny:.01,...(kind==='identity'?{identity:fixtureIdentity()}:{result:fixtureResult()}),...(kind==='review'?{reviewProfile:body.reviewProfile,initialResultHash:body.initialResultHash}:{}),...extra}));
}

test('domestic defaults freeze Kimi / DeepSeek / Kimi and enable independent review',async()=>{
  const {job}=await sample();
  assert.deepEqual(Object.values(job.settings.stageProfiles).map(p=>p.model),['kimi-k3.1-pro','deepseek-flash','kimi-k3.1-pro']);
  assert.equal(job.tasks[0].modelReviewState,'pending');
  assert.equal(job.settingsHash,await hashJSON(job.settings));
  assert.notEqual(job.pipelineVersion,'grading-web-2.1.0');
});

test('different preparation provider attaches to grading ledger without misbilling or replay',async()=>{
  const {job,file}=await sample();
  const material=new File(['Synthetic teacher rules'],'rules.txt',{type:'text/plain'});
  const prepared=await prepareTeachingMaterials({paper:material,solution:material,rubric:material},'kimi');
  const profile=clone(job.settings.stageProfiles.prepare),pack=fixturePack();pack.approved_by='';
  const attempt={id:'domestic-prepare',kind:'prepare',provider:'kimi',stageProfile:profile,stageProfiles:clone(job.settings.stageProfiles),inputs:prepared.inputs,documentHashes:prepared.documentHashes,state:'done',reservedCny:5,costCny:.02,response:{provider:'kimi',stageProfile:profile,pack,warnings:[],documentHashes:prepared.documentHashes,estimatedCny:.02}};
  assert.ok(restorePreparationDraft([attempt],{provider:'kimi',stageProfile:profile,documentHashes:prepared.documentHashes}));
  assert.equal(restorePreparationDraft([attempt],{stageProfile:getDefaultProfile('qwen','prepare')}),null);
  attachPreparation(job,[attempt]);
  const calls=[];
  await runJob(job,{...options,fetcher:async(url,opt)=>{const kind=url.split('/').at(-1),body=JSON.parse(opt.body);calls.push(kind);assert.equal(opt.headers['X-Api-Key'],kind==='review'?keys.review:keys.grade);assert.equal(opt.headers['X-Api-Provider'],kind==='review'?'kimi':'deepseek');assert.deepEqual(body.stageProfiles,job.settings.stageProfiles);return answer(kind,body,{raw:Object.values(keys).join(' ')});}});
  assert.deepEqual(calls,['identity','grade','review']);assert.equal(job.spentCny,.05);
  const snapshot=snapshotJob(job);for(const key of Object.values(keys))assert.ok(!JSON.stringify(snapshot).includes(key));
  const restored=await importBackup(snapshot);await rebindJob(restored,[file],{load:async()=>null});
  assert.equal((await runJob(restored,{...options,fetcher:()=>{throw Error('must not replay');}})).requests,0);
});

test('three independent profile choices include Qwen and use distinct keys within one provider',async()=>{
  const stages={prepare:getDefaultProfile('deepseek','prepare'),grade:getDefaultProfile('qwen','grade','qwen3.8-max'),review:getDefaultProfile('qwen','review','qwen3.8-flash')};
  const {job}=await sample({stageProfiles:stages});let count=0;
  await runJob(job,{...options,fetcher:async(url,opt)=>{count++;const kind=url.split('/').at(-1),body=JSON.parse(opt.body);assert.equal(opt.headers['X-Api-Provider'],'qwen');assert.equal(opt.headers['X-Api-Key'],kind==='review'?keys.review:keys.grade);return answer(kind,body);}});
  assert.equal(count,3);assert.equal(job.tasks[0].modelReviewState,'done');
  await importBackup(snapshotJob(job));
});

test('missing independent key saves identity and initial grading, then resumes only review after restore',async()=>{
  const stages={...clone(DEFAULT_STAGE_PROFILES),grade:getDefaultProfile('qwen','grade','qwen3.8-max'),review:getDefaultProfile('qwen','review','qwen3.8-flash')};
  const {job,file}=await sample({stageProfiles:stages});const calls=[],saved=[];
  const first=await runJob(job,{...options,stageKeys:{grade:keys.grade},persist:async value=>saved.push(snapshotJob(value)),fetcher:async(url,opt)=>{const kind=url.split('/').at(-1);calls.push(kind);assert.equal(opt.headers['X-Api-Key'],keys.grade);return answer(kind,JSON.parse(opt.body));}});
  assert.deepEqual(calls,['identity','grade']);assert.equal(first.paused,true);assert.match(first.reason,/第三步密钥/);
  assert.equal(job.documents[0].identityState,'done');assert.equal(job.tasks[0].reviewAttempts.length,0);assert.equal(job.tasks[0].modelReviewState,'pending');assert.equal(job.tasks[0].result.status,'scored');assert.equal(taskAdvice(job,job.tasks[0]).total,null);assert.equal(job.spentCny,.02);assert.equal(job.heldCny,0);
  const durable=saved.at(-1);assert.equal(durable.tasks[0].state,'done');assert.equal(durable.tasks[0].modelReviewState,'pending');assert.ok(!JSON.stringify(durable).includes(keys.grade));
  const restored=await importBackup(durable);await rebindJob(restored,[file],{load:async()=>null});
  const second=await runJob(restored,{...options,fetcher:async(url,opt)=>{const kind=url.split('/').at(-1);assert.equal(kind,'review');assert.equal(opt.headers['X-Api-Key'],keys.review);calls.push(kind);return answer(kind,JSON.parse(opt.body));}});
  assert.equal(second.paused,false);assert.equal(second.requests,1);assert.deepEqual(calls,['identity','grade','review']);assert.equal(restored.spentCny,.03);assert.equal(restored.heldCny,0);assert.equal(restored.tasks[0].modelReviewState,'done');
  assert.equal(restored.documents[0].attempts.length,1);assert.equal(restored.tasks[0].attempts.length,1);assert.equal(restored.tasks[0].reviewAttempts.length,1);await importBackup(snapshotJob(restored));
});

test('changed stage response or restored model cannot be silently adopted',async()=>{
  const {job}=await sample();
  await runJob(job,{...options,fetcher:async(url,opt)=>answer(url.split('/').at(-1),JSON.parse(opt.body),{stageProfile:getDefaultProfile('qwen','grade')})});
  assert.equal(job.documents[0].identityState,'uncertain');assert.equal(job.heldCny,5);assert.equal(job.tasks[0].result,null);
  const saved=snapshotJob(job);saved.settings.stageProfiles.grade=getDefaultProfile('qwen','grade');saved.settings.provider='qwen';saved.settingsHash=await hashJSON(saved.settings);
  await assert.rejects(()=>importBackup(saved),/服务商|阶段模型/);
});

test('unsupported GPT provider, endpoint injection, and same-model review fail before requests',async()=>{
  for(const change of [s=>s.grade.provider='openai',s=>s.grade.endpoint='https://example.com',s=>s.review=clone(s.grade),s=>s.prepare.apiKey='must-never-persist']){
    const stages=clone(DEFAULT_STAGE_PROFILES);change(stages);await assert.rejects(()=>sample({stageProfiles:stages}));
  }
});


test('restoring a different-provider backup clears all ephemeral keys before applying its settings',async()=>{
  const stages={...clone(DEFAULT_STAGE_PROFILES),grade:getDefaultProfile('qwen')};
  const {job}=await sample({stageProfiles:stages}),originalKeys={prepare:'old-kimi-prepare-key',grade:'old-deepseek-grade-key',review:'old-kimi-review-key'};
  for(const useLocal of [false,true]){
    let currentKeys={...originalKeys},cleared=0,saved;
    const recovered=await restoreSessionBackup(snapshotJob(job),{
      locks,load:async()=>useLocal?job:null,persist:async value=>{saved=snapshotJob(value);},
      clearCredentials:()=>{cleared++;currentKeys={prepare:'',grade:'',review:''};},
    });
    assert.equal(recovered.usedLocal,useLocal);assert.equal(recovered.job.settings.provider,'qwen');
    assert.equal(cleared,1);assert.deepEqual(currentKeys,{prepare:'',grade:'',review:''});
    for(const key of Object.values(originalKeys))assert.ok(!JSON.stringify(saved).includes(key));
    await assert.rejects(()=>runJob(recovered.job,{...options,stageKeys:currentKeys,fetcher:()=>{throw Error('old key must never be sent');}}),/API key/);
  }
  await assert.rejects(()=>restoreSessionBackup(snapshotJob(job),{locks,load:async()=>null,persist:async()=>{}}),/清空/);
});
