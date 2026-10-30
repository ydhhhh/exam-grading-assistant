import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewPreparationDraft,restorePreparationDraft,createJob,prepareTeachingMaterials,attachPreparation,snapshotJob,importBackup} from '../lib/grading/browser-workflow.mjs';
import {DEFAULT_STAGE_PROFILES} from '../lib/grading/providers.mjs';

const clone=value=>structuredClone(value);
const oldWarnings=[
  '材料标注为合成测试；评分细则末句要求先由测试者核对，approved_by 留空待人工确认。',
  'C1、C2 在材料中仅规定0分或2分档，未提供其他部分分档；allowed_scores 按材料如实填写。',
];
const notes=['评分点仅允许0分或2分，已按明确规定提取。','规则草案须经教师核对后确认。'];
const draft=()=>({exam_id:'SYNTHETIC_DICE',title:'合成骰子测试',version:'draft-1',demo:false,approved_by:'',policies:'只按指定评分点评分，不重复计分。',questions:[{question_id:'Q1',text:'公平六面骰点数X，求P(X>4)。',solution:'有利点数{5,6}；2/6=1/3。',max_score:4,criteria:[{criterion_id:'C1',description:'列出{5,6}得2分，否则0分。',allowed_scores:[0,2],requires:[]},{criterion_id:'C2',description:'正确计算2/6=1/3得2分，否则0分。',allowed_scores:[0,2],requires:[]}]}]});
const attempt=()=>({id:'synthetic-preparation',kind:'prepare',state:'done',reservedCny:1,costCny:.01640025,response:{pack:draft(),warnings:clone(oldWarnings),ready:true,raw:'synthetic original response preserved',usage:{input_tokens:1273,output_tokens:1504}}});
const reviewInput=()=>({pack:draft(),resolutions:['对照试题和细则，合成标记不改变题目；页面确认后才使用规则。','细则明确每点只有0分或2分，无缺失分档，原提取正确。'],reviewer:'合成测试核对人',changeSummary:''});

test('informational notes restore without blocking, but never grant page approval',()=>{
  const source=attempt();source.response.warnings=[];source.response.notes=notes;
  const restored=restorePreparationDraft([source]);
  assert.equal(restored.ready,true);assert.equal(restored.pack.approved_by,'');assert.deepEqual(restored.notes,notes);assert.deepEqual(restored.warnings,[]);
  assert.equal(restored.review,undefined);
  restored.notes.push('local-only');assert.equal(source.response.notes.length,2);
});

test('old real-response warning wording stays blocked until each issue receives an explicit review',()=>{
  const source=attempt(),before=clone(source);
  const blocked=restorePreparationDraft([source]);assert.equal(blocked.ready,false);assert.deepEqual(blocked.notes,[]);
  const reviewed=reviewPreparationDraft([source],reviewInput()),restored=restorePreparationDraft(reviewed);
  assert.deepEqual(source,before);assert.deepEqual(reviewed[0].response,before.response);assert.equal(reviewed[0].costCny,before.costCny);
  assert.equal(restored.ready,true);assert.equal(restored.pack.approved_by,'');assert.deepEqual(restored.warnings,oldWarnings);
  assert.deepEqual(restored.review.resolutions,reviewInput().resolutions);assert.equal(restored.review.reviewer,'合成测试核对人');
  const afterReload=restorePreparationDraft(JSON.parse(JSON.stringify(reviewed)));
  assert.equal(afterReload.pack.approved_by,'');assert.equal(afterReload.ready,true);
});

test('edited rules require a revision explanation and remain detached from the model response',()=>{
  const input=reviewInput();input.pack.questions[0].criteria[0].description+=' 明确写出5点和6点也等价。';
  assert.throws(()=>reviewPreparationDraft([attempt()],input),/修订说明/);
  input.changeSummary='按教师细则补全等价的文字表述。';
  const reviewed=reviewPreparationDraft([attempt()],input),restored=restorePreparationDraft(reviewed);
  assert.equal(restored.pack.questions[0].criteria[0].description,input.pack.questions[0].criteria[0].description);
  assert.notEqual(reviewed[0].response.pack.questions[0].criteria[0].description,input.pack.questions[0].criteria[0].description);
  input.pack.title='later change';assert.notEqual(restored.pack.title,input.pack.title);
});

test('review cannot waive incomplete resolutions, identities, structural score errors or model approval',()=>{
  for(const change of [
    x=>x.resolutions=[],x=>x.resolutions.pop(),x=>x.resolutions.push('extra'),x=>x.resolutions[0]=' ',x=>x.resolutions[0]='a'.repeat(2001),
    x=>x.reviewer='',x=>x.reviewer='a'.repeat(201),x=>x.pack.questions[0].max_score=9,x=>x.pack.questions[0].criteria[1].criterion_id='C1',
    x=>x.pack.approved_by='model-approved',x=>x.pack.demo=true,
  ]){const input=reviewInput();change(input);assert.throws(()=>reviewPreparationDraft([attempt()],input));}
  for(const state of ['in_flight','uncertain','error','response_saved']){const source=attempt();source.state=state;assert.throws(()=>reviewPreparationDraft([source],reviewInput()));}
  assert.throws(()=>reviewPreparationDraft([],reviewInput()));
});

test('restoration refuses malformed notes and tampered or stale local review records',()=>{
  for(const notes of [null,'not-an-array',[''],['x'.repeat(2001)],Array(101).fill('note')]){const source=attempt();source.response.notes=notes;assert.equal(restorePreparationDraft([source]),null);}
  for(const change of [
    x=>x.response.pack.title='different material',x=>x.response.warnings[0]='different missing policy',
    x=>x.ruleReview.reviewer='',x=>x.ruleReview.pack.questions[0].max_score=9,x=>x.ruleReview.resolutions.pop(),
    x=>x.ruleReview.extra='unknown-field',x=>x.ruleReview.reviewedAt='invalid date',x=>x.ruleReview.reviewedAt='2026-02-30T00:00:00.000Z',x=>x.ruleReview.pack.approved_by='auto-approved',
  ]){const reviewed=reviewPreparationDraft([attempt()],reviewInput());change(reviewed[0]);assert.equal(restorePreparationDraft(reviewed),null);}
});

async function persistedSample(){
  const material=new File(['Synthetic teacher rule fixture'],'rules.txt',{type:'text/plain'}),prepared=await prepareTeachingMaterials({paper:material,solution:material,rubric:material},'kimi');
  const source={...attempt(),provider:'kimi',stageProfile:clone(DEFAULT_STAGE_PROFILES.prepare),stageProfiles:clone(DEFAULT_STAGE_PROFILES),inputs:prepared.inputs,documentHashes:prepared.documentHashes};
  Object.assign(source.response,{provider:'kimi',stageProfile:clone(DEFAULT_STAGE_PROFILES.prepare),documentHashes:prepared.documentHashes,estimatedCny:source.costCny});
  const reviewed=reviewPreparationDraft([source],reviewInput());
  const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nN8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
  const file=new File([png],'01.png',{type:'image/png'});Object.defineProperty(file,'webkitRelativePath',{value:'SYN001/Q1/01.png'});
  const approved={...draft(),approved_by:'合成测试核对人'},job=await createJob(approved,[file]);
  attachPreparation(job,reviewed);return {job,source,reviewed};
}

test('snapshot and import preserve original model output, teacher review, and exact preparation fees',async()=>{
  const {job,source,reviewed}=await persistedSample(),snapshot=snapshotJob(job),restored=await importBackup(JSON.stringify(snapshot));
  assert.deepEqual(restored.preparationAttempts[0].response,source.response);
  assert.deepEqual(restored.preparationAttempts[0].ruleReview,reviewed[0].ruleReview);
  assert.equal(restored.spentCny,.01640025);assert.equal(restored.heldCny,0);
  assert.equal(restored.tasks[0].attempts.length,0);assert.equal(restored.tasks[0].reviewAttempts.length,0);
  assert.equal(restorePreparationDraft(restored.preparationAttempts).pack.approved_by,'');
  for(const change of [x=>x.ruleReview.resolutions.pop(),x=>x.response.pack.title='changed source',x=>x.ruleReview.pack.questions[0].max_score=10]){
    const invalid=clone(snapshot);change(invalid.preparationAttempts[0]);await assert.rejects(()=>importBackup(invalid));
  }
});

test('an attached preparation review does not rewrite a separately imported valid course pack',async()=>{
  const {job,reviewed}=await persistedSample();
  const before=clone(job.pack);attachPreparation(job,reviewed);
  assert.deepEqual(job.pack,before);assert.equal(job.pack.approved_by,'合成测试核对人');
});
