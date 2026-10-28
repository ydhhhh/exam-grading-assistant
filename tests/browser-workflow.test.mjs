import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {VERSION} from '../lib/grading/validation.mjs';
import {DEFAULT_SETTINGS,canonical,hashJSON,readUpload,indexAnswers,createJob,snapshotJob,importBackup,rebindJob,reviewTask,requeueTask,runJob,exportCSV,demoJob,attachPreparation,restorePreparationDraft} from '../lib/grading/browser-workflow.mjs';

if(!globalThis.crypto)globalThis.crypto=webcrypto;
const PNG=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nN8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
const file=(path,tag='')=>{const f=new File([PNG,tag],path.split('/').at(-1),{type:'image/png'});Object.defineProperty(f,'webkitRelativePath',{value:path});return f;};
function pack(demo=false){return {exam_id:'E1',title:'合成测试',version:'1',demo,approved_by:'测试教师',policies:'按测试分值，不用于真实学生。',questions:['Q1','Q2'].map(q=>({question_id:q,text:'合成题目',solution:'合成答案',max_score:3,criteria:[{criterion_id:'C1',description:'合成步骤',allowed_scores:[0,1],requires:[]},{criterion_id:'C2',description:'合成结论',allowed_scores:[0,1,2],requires:[]}]}))};}
const files=()=>[file('class/S001/Q1/01.png','a'),file('class/S001/Q2/01.png','b')];
const locks={request:async(_name,_opts,fn)=>fn({name:'test'})};
const stored=[];const persist=async job=>{stored.push(snapshotJob(job));};
function result(questionId){return {question_id:questionId,status:'scored',criteria:[{criterion_id:'C1',awarded:1,evidence_refs:['P1'],reason:'合成依据'},{criterion_id:'C2',awarded:2,evidence_refs:['P1'],reason:'合成依据'}],flags:[],alternative_solution:false};}
function response(questionId,cost=0.01){return {result:result(questionId),usage:{input_tokens:100,output_tokens:100},requestId:'server-r1',responseId:'resp1',model:'mock',raw:'raw-result',estimatedCny:cost};}
const asResponse=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'Content-Type':'application/json'}});
function runnerOptions(fetcher,options={}){let ms=100000;return {apiKey:'sk-test-DO-NOT-STORE',locks,persist,load:async()=>null,fetcher,clock:()=>ms,sleep:async wait=>{ms+=wait;},...options};}

test('canonical fingerprints sort keys and reject undefined/nonfinite',async()=>{
 assert.equal(canonical({b:2,a:1}),'{"a":1,"b":2}');assert.equal(await hashJSON({b:2,a:1}),await hashJSON({a:1,b:2}));assert.throws(()=>canonical({a:undefined}));assert.throws(()=>canonical(NaN));
});
test('indexes folder root, numeric continuations and full roster cross product',async()=>{
 const indexed=await indexAnswers([file('class/S001/Q1/10.png','ten'),file('class/S001/Q1/02.png','two')],pack(),['S001','S002']);
 assert.equal(indexed.tasks.length,4);assert.equal(indexed.tasks[0].pages[0].path,'class/S001/Q1/02.png');assert.equal(indexed.tasks.filter(t=>!t.inputComplete).length,3);
});
test('flat names preserve student underscore and refuse unmapped full paper',async()=>{
 const indexed=await indexAnswers([file('batch/TA_001_Q1_01.png')],pack());assert.equal(indexed.tasks[0].studentId,'TA_001');
 await assert.rejects(()=>indexAnswers([new File(['%PDF-1.4'],'S001.pdf')],pack()),/无法确定/);
});
test('unknown files, roster outsiders and duplicate page ordinals are not silently ignored',async()=>{
 await assert.rejects(()=>indexAnswers([...files(),new File(['x'],'notes.txt')],pack()),/不支持/);
 await assert.rejects(()=>indexAnswers(files(),pack(),['S002']),/名单外/);
 await assert.rejects(()=>indexAnswers([file('S001/Q1/01.png','a'),file('S001_Q1_01.png','b')],pack()),/顺序重复/);
 const x=await indexAnswers([...files(),new File(['x'],'.DS_Store')],pack());assert.equal(x.tasks.length,2);
});
test('paths and same-question duplicate content are rejected',async()=>{
 await assert.rejects(()=>indexAnswers([file('../S001/Q1/01.png')],pack()),/路径/);
 await assert.rejects(()=>indexAnswers([file('S001/Q1/01.png'),file('S001/Q1/02.png')],pack()),/重复页/);
});
test('file type and size checks happen before upload',async()=>{
 await assert.rejects(()=>readUpload(new File(['text'],'not.png')),/PNG/);
 await assert.rejects(()=>indexAnswers([file('S001/Q1/01.webp')],pack()),/WebP/);
 const p=await readUpload(file('S001/Q1/01.png'),'page-1.png');assert.equal(p.name,'page-1.png');assert.match(p.sha256,/^[0-9a-f]{64}$/);assert.ok(p.data.length);
});
test('snapshots omit file and key; restored job must rebind and hash-match originals',async()=>{
 const job=await createJob(pack(),files());job.apiKey='secret';const snapshot=snapshotJob(job);
 assert.ok(!JSON.stringify(snapshot).includes('secret'));assert.equal(snapshot.tasks[0].pages[0].file,undefined);
 const restored=await importBackup(JSON.stringify(snapshot));assert.equal(restored.tasks[0].pages[0].file,undefined);
 await rebindJob(restored,files());assert.ok(restored.tasks[0].pages[0].file);
 await assert.rejects(()=>rebindJob(restored,[file('class/S001/Q1/01.png','changed'),files()[1]]),/改变/);
});
test('backup rejects changed rules, settings, omitted question and invented totals',async()=>{
 const original=snapshotJob(await createJob(pack(),files()));
 for(const change of [x=>x.pack.title='tampered',x=>x.settings.budgetCny=10000,x=>x.tasks.pop(),x=>x.spentCny=1]){const d=structuredClone(original);change(d);await assert.rejects(()=>importBackup(d));}
});
test('real run requires key and exclusive web lock before network',async()=>{
 const job=await createJob(pack(),files());let calls=0;const fetcher=async()=>{calls++;};
 await assert.rejects(()=>runJob(job,runnerOptions(fetcher,{apiKey:''})),/key/);
 await assert.rejects(()=>runJob(job,runnerOptions(fetcher,{locks:null})),/任务锁/);
 await assert.rejects(()=>runJob(job,runnerOptions(fetcher,{locks:{request:async(_,__,fn)=>fn(null)}})),/另一个页面/);
 assert.equal(calls,0);
});
test('serial independent A/B run persists before calls, reuses results, and does not leak identities or key',async()=>{
 const job=await createJob(pack(),files());let calls=0;stored.length=0;
 const fetcher=async(url,opt)=>{calls++;const body=JSON.parse(opt.body);assert.equal(url,'/api/grade');assert.equal(opt.headers['X-Api-Key'],'sk-test-DO-NOT-STORE');assert.equal(stored.at(-1).tasks.find(t=>t.questionId===body.questionId).attempts.at(-1).state,'in_flight');assert.ok(!opt.body.includes('S001'));assert.ok(!Object.hasOwn(body,'results'));return asResponse(response(body.questionId));};
 assert.equal((await runJob(job,runnerOptions(fetcher))).requests,4);assert.equal(calls,4);assert.equal(job.spentCny,.04);assert.equal(job.heldCny,0);
 assert.equal((await runJob(job,runnerOptions(fetcher))).requests,0);assert.ok(!JSON.stringify(snapshotJob(job)).includes('sk-test-DO-NOT-STORE'));
 assert.match(exportCSV(job),/AI建议成绩/);assert.ok(job.tasks.every(t=>t.review===null));
});
test('budget reserves before request and stops subsequent calls',async()=>{
 const job=await createJob(pack(),files(),{budgetCny:5,requestReserveCny:5});let calls=0;
 await assert.rejects(()=>runJob(job,runnerOptions(async(_,opt)=>{calls++;return asResponse(response(JSON.parse(opt.body).questionId,1));})),/预算/);
 assert.equal(calls,1);assert.equal(job.spentCny,1);assert.equal(job.heldCny,0);
});
test('network unknown holds reserve and never auto-retries',async()=>{
 const job=await createJob(pack(),files());let calls=0;
 await runJob(job,runnerOptions(async()=>{calls++;throw Error('network sk-test-DO-NOT-STORE');}));
 assert.equal(job.heldCny,5);assert.equal(job.tasks[0].state,'uncertain');assert.equal(calls,1);
 assert.throws(()=>requeueTask(job.tasks[0]),/再次计费/);requeueTask(job.tasks[0],true);assert.equal(job.heldCny,5);
 assert.ok(!JSON.stringify(snapshotJob(job)).includes('sk-test-DO-NOT-STORE'));
});
test('HTTP rate limit stops queue without retries and releases known unused reserve',async()=>{
 const job=await createJob(pack(),files());let calls=0;
 const r=await runJob(job,runnerOptions(async()=>{calls++;return asResponse({error:'限流',code:'RATE_LIMIT',uncertain:false},429);}));
 assert.equal(calls,1);assert.equal(r.paused,true);assert.equal(job.heldCny,0);assert.equal(job.tasks[0].state,'error');
});
test('invalid/refused response cost is recorded and no zero grade is fabricated',async()=>{
 const job=await createJob(pack(),files());
 await runJob(job,runnerOptions(async()=>asResponse({error:'拒答',code:'REFUSAL',uncertain:false,estimatedCny:.02,usage:{input_tokens:100,output_tokens:5}},400)));
 assert.equal(job.spentCny,.04);assert.equal(job.tasks[0].results.A,null);assert.match(exportCSV(job),/未完成/);
});
test('success without reported usage keeps estimated reserve held',async()=>{
 const job=await createJob(pack(),files());
 await runJob(job,runnerOptions(async(_,opt)=>asResponse({...response(JSON.parse(opt.body).questionId),usage:null,estimatedCny:null})));
 assert.equal(job.spentCny,0);assert.equal(job.heldCny,20);await importBackup(snapshotJob(job));
});
test('key echoed from failed server is redacted before persistence',async()=>{
 const job=await createJob(pack(),files());await runJob(job,runnerOptions(async()=>asResponse({error:'sk-test-DO-NOT-STORE',raw:'sk-test-DO-NOT-STORE',uncertain:false},401)));
 assert.ok(!JSON.stringify(snapshotJob(job)).includes('sk-test-DO-NOT-STORE'));assert.match(job.tasks[0].error,/REDACTED/);
});
test('storage failure before request makes zero network calls',async()=>{
 const job=await createJob(pack(),files());let calls=0;
 await assert.rejects(()=>runJob(job,runnerOptions(async()=>{calls++;},{persist:async()=>{throw Error('quota');}})),/quota/);assert.equal(calls,0);
});
test('page restart marks inflight uncertain and preserves reserve',async()=>{
 const job=await createJob(pack(),files());const t=job.tasks[0];
 t.attempts.push({id:'interrupted',lane:'A',state:'in_flight',reservedCny:5,costCny:null,sentAt:new Date().toISOString()});t.state='running';job.heldCny=5;
 const restored=await importBackup(snapshotJob(job));assert.equal(restored.tasks[0].state,'uncertain');assert.equal(restored.heldCny,5);
});
test('saved API response restores without reissuing that lane',async()=>{
 const job=await createJob(pack(),files());let storedResponse,failOnce=true;
 const persistence=async j=>{if(j.tasks[0].attempts[0]?.state==='response_saved'){storedResponse=snapshotJob(j);if(failOnce){failOnce=false;throw Error('simulated crash');}}};
 await assert.rejects(()=>runJob(job,runnerOptions(async(_,opt)=>asResponse(response(JSON.parse(opt.body).questionId)),{persist:persistence})),/simulated crash/);
 const restored=await importBackup(storedResponse);await rebindJob(restored,files());let calls=0;
 await runJob(restored,runnerOptions(async(_,opt)=>{calls++;return asResponse(response(JSON.parse(opt.body).questionId));}));assert.equal(calls,3);assert.equal(restored.spentCny,.04);
});
test('pause makes no requests, missing tasks remain in CSV with blank total',async()=>{
 const job=await createJob(pack(),[files()[0]]);let calls=0;await runJob(job,runnerOptions(async()=>{calls++;},{shouldStop:()=>true}));assert.equal(calls,0);assert.match(exportCSV(job),/未完成/);
});
test('second stale tab reads durable valid results under the lock and sends nothing',async()=>{
 const first=await createJob(pack(),files());const second=await importBackup(snapshotJob(first));await rebindJob(second,files());
 await runJob(first,runnerOptions(async(_,opt)=>asResponse(response(JSON.parse(opt.body).questionId))));
 let calls=0;const r=await runJob(second,runnerOptions(async()=>{calls++;},{load:async()=>importBackup(snapshotJob(first))}));
 assert.equal(calls,0);assert.equal(r.requests,0);assert.ok(second.tasks.every(t=>t.results.A&&t.results.B));
});
test('manual review reason optional, changes preserved, scores/rereviewer constrained',async()=>{
 const job=await createJob(pack(),files()),t=job.tasks[0];reviewTask(t,{C1:1,C2:1},'TA','');reviewTask(t,{C1:1,C2:2},'TA',' ');
 assert.equal(t.review.reason,'');assert.equal(t.reviewHistory.length,2);
 assert.throws(()=>reviewTask(t,{C1:1,C2:2},'',''));assert.throws(()=>reviewTask(t,{C1:99,C2:2},'TA',''));
 await importBackup(snapshotJob(job));const restored=await importBackup(snapshotJob(job));assert.throws(()=>reviewTask(restored.tasks[0],{C1:1,C2:2},'TA',''),/原图/);
});
test('material preparation fees and uncertain reserves join the immutable task budget',async()=>{
 const job=await createJob(pack(),files());
 attachPreparation(job,[{id:'prepare1',state:'done',reservedCny:5,costCny:.3,raw:'response',apiKey:'do-not-save'}, {id:'prepare2',state:'in_flight',reservedCny:5,costCny:null}]);
 assert.equal(job.spentCny,.3);assert.equal(job.heldCny,5);assert.equal(job.preparationAttempts[1].state,'uncertain');assert.ok(!JSON.stringify(snapshotJob(job)).includes('do-not-save'));
 const restored=await importBackup(snapshotJob(job));assert.equal(restored.spentCny,.3);assert.equal(restored.heldCny,5);
 assert.throws(()=>attachPreparation(job,[job.preparationAttempts[0]]),/不能移除/);
});
test('rebind refreshes durable decisions before restoring file handles',async()=>{
 const job=await createJob(pack(),files()),latest=await importBackup(snapshotJob(job));await rebindJob(latest,files());reviewTask(latest.tasks[0],{C1:1,C2:2},'TA','');
 await rebindJob(job,files(),{load:async()=>importBackup(snapshotJob(latest))});assert.equal(job.tasks[0].review.reviewer,'TA');assert.ok(job.tasks[0].pages[0].file);
});
test('demo job runs without network even when key provided',async()=>{
 const job=await demoJob();assert.equal(job.pipelineVersion,VERSION);assert.equal(job.demo,true);let calls=0;
 await runJob(job,runnerOptions(async()=>{calls++;throw Error('must not call');}));assert.equal(calls,0);assert.equal(job.spentCny,0);assert.equal(job.heldCny,0);assert.match(exportCSV(job),/合成演示/);assert.ok(job.tasks.every(t=>t.results.A&&t.results.B));
});

test('shared 3 MiB upload cap rejects before file contents are read',async()=>{
  let read=false;const huge={name:'large.pdf',size:3*1024*1024+1,arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}};
  await assert.rejects(()=>readUpload(huge),/3 MiB/);assert.equal(read,false);
  huge.name='S001_Q1_01.png';await assert.rejects(()=>indexAnswers([huge],pack()),/3 MiB/);assert.equal(read,false);
});

test('SERVER_BUSY pauses entire batch and permits explicit retry without cost',async()=>{
 const job=await createJob(pack(),files());let calls=0;
 const r=await runJob(job,runnerOptions(async()=>{calls++;return asResponse({error:'网站繁忙，本次未调用API',code:'SERVER_BUSY',uncertain:false,estimatedCny:0},429);}));
 assert.equal(calls,1);assert.equal(r.paused,true);assert.equal(job.spentCny,0);assert.equal(job.heldCny,0);assert.equal(job.tasks[0].state,'error');
 assert.equal(job.tasks[0].attempts.length,1);assert.equal(job.tasks[1].attempts.length,0);assert.equal(job.tasks[1].state,'ready');
 requeueTask(job.tasks[0]);assert.equal(job.tasks[0].state,'ready');
 const resumed=await runJob(job,runnerOptions(async(_,opt)=>asResponse(response(JSON.parse(opt.body).questionId))));
 assert.equal(resumed.requests,4);assert.ok(job.tasks.every(t=>t.state==='done'));
});


test('uncertain or server-error responses pause the whole batch without replay',async()=>{
 for(const [status,uncertain] of [[502,true],[503,false],[422,true]]){
  const job=await createJob(pack(),files());let calls=0;
  const outcome=await runJob(job,runnerOptions(async()=>{calls++;return asResponse({error:'合成断网',code:'NETWORK',uncertain,estimatedCny:null},status);}));
  assert.equal(calls,1);assert.equal(outcome.paused,true);assert.equal(job.tasks[1].attempts.length,0);assert.equal(job.tasks[1].state,'ready');
  assert.equal(job.tasks[0].attempts.length,1);assert.equal(job.tasks[0].state,uncertain?'uncertain':'error');
  assert.equal(job.spentCny,0);assert.equal(job.heldCny,uncertain?5:0);
  const restored=await importBackup(snapshotJob(job));await rebindJob(restored,files());
  let firstQuestionCalls=0;await runJob(restored,runnerOptions(async(_,options)=>{const q=JSON.parse(options.body).questionId;if(q==='Q1')firstQuestionCalls++;return asResponse(response(q));}));
  assert.equal(firstQuestionCalls,0);
 }
});

test('earlier completed question survives a later disconnect and restart',async()=>{
 const job=await createJob(pack(),files());let calls=0,durable;
 await runJob(job,runnerOptions(async(_,opt)=>{calls++;if(calls===3)throw Error('connection lost');return asResponse(response(JSON.parse(opt.body).questionId));},{persist:async j=>{durable=snapshotJob(j);}}));
 const restored=await importBackup(durable);assert.ok(restored.tasks[0].results.A&&restored.tasks[0].results.B);assert.equal(restored.tasks[1].state,'uncertain');assert.equal(restored.spentCny,.02);assert.equal(restored.heldCny,5);
 await rebindJob(restored,files());let nextCalls=0;await runJob(restored,runnerOptions(async()=>{nextCalls++;throw Error('unexpected');}));assert.equal(nextCalls,0);
});

test('failed response storage leaves durable in-flight request uncertain after restart',async()=>{
 const job=await createJob(pack(),files());let durable,calls=0;
 await assert.rejects(()=>runJob(job,runnerOptions(async(_,opt)=>{calls++;return asResponse(response(JSON.parse(opt.body).questionId));},{persist:async j=>{if(j.tasks[0].attempts[0]?.state==='response_saved')throw Error('storage full');durable=snapshotJob(j);}})),/storage full/);
 assert.equal(calls,1);const restored=await importBackup(durable);assert.equal(restored.tasks[0].state,'uncertain');assert.equal(restored.heldCny,5);assert.equal(restored.tasks[0].results.A,null);
});

function preparationDraft(overrides={}){
 const draft={...pack(),approved_by:''};
 return {id:'prepare-latest',lane:'prepare',state:'done',response:{pack:draft,warnings:[],ready:true},...overrides};
}
test('latest completed preparation restores a detached unapproved draft without key metadata',()=>{
 const latest=preparationDraft();latest.response.apiKey='do-not-copy';
 const restored=restorePreparationDraft([latest]);
 assert.equal(restored.pack.approved_by,'');assert.equal(restored.ready,true);assert.deepEqual(restored.warnings,[]);assert.ok(!JSON.stringify(restored).includes('do-not-copy'));
 restored.pack.title='changed locally';assert.notEqual(latest.response.pack.title,restored.pack.title);
});
test('restored preparation warnings remain blockers even if ready metadata says true',()=>{
 const latest=preparationDraft();latest.response.warnings=['部分分政策尚未提供'];
 const restored=restorePreparationDraft([latest]);assert.equal(restored.ready,false);assert.deepEqual(restored.warnings,['部分分政策尚未提供']);assert.equal(restored.pack.approved_by,'');
});
test('preparation recovery never falls back before a newer failed interrupted or invalid attempt',()=>{
 const older=preparationDraft();
 for(const state of ['error','uncertain','in_flight','response_saved'])assert.equal(restorePreparationDraft([older,preparationDraft({state})]),null);
 const invalid=preparationDraft();invalid.response.pack.questions=[];assert.equal(restorePreparationDraft([older,invalid]),null);
 assert.equal(restorePreparationDraft([]),null);assert.equal(restorePreparationDraft(null),null);
});
test('preparation recovery rejects malformed policy metadata and preapproved or demo packs',()=>{
 for(const mutate of [x=>x.response.pack.approved_by='automatically approved',x=>x.response.pack.demo=true,x=>x.response.warnings=[''],x=>x.response.warnings=['x'.repeat(2001)],x=>x.response.warnings='missing',x=>x.response.pack.questions[0].max_score=99,x=>x.lane='A']){
  const latest=preparationDraft();mutate(latest);assert.equal(restorePreparationDraft([latest]),null);
 }
});
