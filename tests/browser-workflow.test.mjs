import {renderPDF} from './helpers/pdf-rendering.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {VERSION} from '../lib/grading/validation.mjs';
import {DEFAULT_SETTINGS,canonical,hashJSON,readUpload,indexAnswers,createJob as createDefaultJob,snapshotJob,importBackup,rebindJob,reviewTask,requeueTask,runJob,exportCSV,demoJob,attachPreparation,restorePreparationDraft,restoreBackupSafely} from '../lib/grading/browser-workflow.mjs';

import {DEFAULT_STAGE_PROFILES} from '../lib/grading/providers.mjs';
// Isolate the original single-pass ledger tests; default three-stage behavior has separate coverage.
const createJob=(p,f,s={},r)=>createDefaultJob(p,f,{reviewProfile:null,...s},r);
const createStudentPDFJob=(p,f,s={},r)=>createDefaultStudentPDFJob(p,f,{reviewProfile:null,...s},r);
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const PNG=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nN8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
const file=(path,tag='')=>{const f=new File([PNG,tag],path.split('/').at(-1),{type:'image/png'});Object.defineProperty(f,'webkitRelativePath',{value:path});return f;};
function pack(demo=false){return {exam_id:'E1',title:'合成测试',version:'1',demo,approved_by:'测试教师',policies:'按测试分值，不用于真实学生。',questions:['Q1','Q2'].map(q=>({question_id:q,text:'合成题目',solution:'合成答案',max_score:3,criteria:[{criterion_id:'C1',description:'合成步骤',allowed_scores:[0,1],requires:[]},{criterion_id:'C2',description:'合成结论',allowed_scores:[0,1,2],requires:[]}]}))};}
const files=()=>[file('class/S001/Q1/01.png','a'),file('class/S001/Q2/01.png','b')];
const locks={request:async(_name,_opts,fn)=>fn({name:'test'})};
const stored=[];const persist=async job=>{stored.push(snapshotJob(job));};
function result(questionId){return {question_id:questionId,status:'scored',criteria:[{criterion_id:'C1',awarded:1,evidence_refs:['P1'],reason:'合成依据'},{criterion_id:'C2',awarded:2,evidence_refs:['P1'],reason:'合成依据'}],flags:[],alternative_solution:false};}
function response(questionId,cost=0.01){return {result:result(questionId),usage:{input_tokens:100,output_tokens:100},requestId:'server-r1',responseId:'resp1',model:'mock',raw:'raw-result',estimatedCny:cost};}
const asResponse=(obj,status=200)=>new Response(JSON.stringify(obj&&typeof obj==='object'&&!Array.isArray(obj)?{provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,...obj}:obj),{status,headers:{'Content-Type':'application/json'}});
function runnerOptions(fetcher,options={}){let ms=100000;return {renderPDF,apiKey:'sk-test-DO-NOT-STORE',locks,persist,load:async()=>null,fetcher,clock:()=>ms,sleep:async wait=>{ms+=wait;},...options};}

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
test('single grading persists before calls, reuses results, and does not leak identities or key',async()=>{
 const job=await createJob(pack(),files());let calls=0;stored.length=0;
 const fetcher=async(url,opt)=>{calls++;const body=JSON.parse(opt.body);assert.equal(url,'/api/grade');assert.equal(opt.headers['X-Api-Key'],'sk-test-DO-NOT-STORE');assert.equal(stored.at(-1).tasks.find(t=>t.questionId===body.questionId).attempts.at(-1).state,'in_flight');assert.ok(!opt.body.includes('S001'));assert.ok(!Object.hasOwn(body,'results'));return asResponse(response(body.questionId));};
 assert.equal((await runJob(job,runnerOptions(fetcher))).requests,2);assert.equal(calls,2);assert.equal(job.spentCny,.02);assert.equal(job.heldCny,0);
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
 assert.equal(job.spentCny,.04);assert.equal(job.tasks[0].result,null);assert.match(exportCSV(job),/未完成/);
});
test('success without reported usage preserves the result and reserve and pauses new requests',async()=>{
 const job=await createJob(pack(),files(),{concurrency:1});
 const out=await runJob(job,runnerOptions(async(_,opt)=>asResponse({...response(JSON.parse(opt.body).questionId),usage:null,estimatedCny:null})));
 assert.equal(out.paused,true);assert.equal(out.requests,1);assert.equal(job.tasks[0].state,'done');assert.equal(job.tasks[1].state,'ready');
 assert.equal(job.spentCny,0);assert.equal(job.heldCny,5);await importBackup(snapshotJob(job));
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
 t.attempts.push({id:'interrupted',kind:'grade',provider:'deepseek',stageProfile:DEFAULT_STAGE_PROFILES.grade,inputs:t.pages.map(p=>({page_id:p.page_id,sourceSha256:p.sha256,sourceMime:p.mime,sha256:p.sha256,mime:p.mime,size:p.size,renderVersion:'original-v1'})),state:'in_flight',reservedCny:5,costCny:null,sentAt:new Date().toISOString()});t.state='running';job.heldCny=5;
 const restored=await importBackup(snapshotJob(job));assert.equal(restored.tasks[0].state,'uncertain');assert.equal(restored.heldCny,5);
});
test('saved API response restores without reissuing that request',async()=>{
 const job=await createJob(pack(),files());let storedResponse,failOnce=true;
 const persistence=async j=>{if(j.tasks[0].attempts[0]?.state==='response_saved'){storedResponse=snapshotJob(j);if(failOnce){failOnce=false;throw Error('simulated crash');}}};
 await assert.rejects(()=>runJob(job,runnerOptions(async(_,opt)=>asResponse(response(JSON.parse(opt.body).questionId)),{persist:persistence})),/simulated crash/);
 const restored=await importBackup(storedResponse);await rebindJob(restored,files());let calls=0;
 await runJob(restored,runnerOptions(async(_,opt)=>{calls++;return asResponse(response(JSON.parse(opt.body).questionId));}));assert.equal(calls,1);assert.equal(restored.spentCny,.02);
});
test('pause makes no requests, missing tasks remain in CSV with blank total',async()=>{
 const job=await createJob(pack(),[files()[0]]);let calls=0;await runJob(job,runnerOptions(async()=>{calls++;},{shouldStop:()=>true}));assert.equal(calls,0);assert.match(exportCSV(job),/未完成/);
});
test('second stale tab reads durable valid results under the lock and sends nothing',async()=>{
 const first=await createJob(pack(),files());const second=await importBackup(snapshotJob(first));await rebindJob(second,files());
 await runJob(first,runnerOptions(async(_,opt)=>asResponse(response(JSON.parse(opt.body).questionId))));
 let calls=0;const r=await runJob(second,runnerOptions(async()=>{calls++;},{load:async()=>importBackup(snapshotJob(first))}));
 assert.equal(calls,0);assert.equal(r.requests,0);assert.ok(second.tasks.every(t=>t.result));
});
test('manual review reason optional, changes preserved, scores/rereviewer constrained',async()=>{
 const job=await createJob(pack(),files()),t=job.tasks[0];reviewTask(t,{C1:1,C2:1},'TA','');reviewTask(t,{C1:1,C2:2},'TA',' ');
 assert.equal(t.review.reason,'');assert.equal(t.reviewHistory.length,2);
 assert.throws(()=>reviewTask(t,{C1:1,C2:2},'',''));assert.throws(()=>reviewTask(t,{C1:99,C2:2},'TA',''));
 await importBackup(snapshotJob(job));const restored=await importBackup(snapshotJob(job));assert.throws(()=>reviewTask(restored.tasks[0],{C1:1,C2:2},'TA',''),/原图/);
});
test('material preparation fees and uncertain reserves join the immutable task budget',async()=>{
 const job=await createJob(pack(),files());
 const inputs=['paper','solution','rubric'].map(role=>({role,page_id:'P1',sourceSha256:'a'.repeat(64),sourceMime:'text/plain',sha256:'a'.repeat(64),mime:'text/plain',size:10,renderVersion:'original-v1'}));
 const base={kind:'prepare',provider:'kimi',stageProfile:DEFAULT_STAGE_PROFILES.prepare,inputs,documentHashes:Object.fromEntries(inputs.map(p=>[p.role,p.sourceSha256]))};
 attachPreparation(job,[{...base,id:'prepare1',state:'done',reservedCny:5,costCny:.3,raw:'response',response:{stageProfile:DEFAULT_STAGE_PROFILES.prepare},apiKey:'do-not-save'}, {...base,id:'prepare2',state:'in_flight',reservedCny:5,costCny:null}]);
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
 await runJob(job,runnerOptions(async()=>{calls++;throw Error('must not call');}));assert.equal(calls,0);assert.equal(job.spentCny,0);assert.equal(job.heldCny,0);assert.match(exportCSV(job),/合成演示/);assert.ok(job.tasks.every(t=>t.result));
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
 assert.equal(resumed.requests,2);assert.ok(job.tasks.every(t=>t.state==='done'));
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
 await runJob(job,runnerOptions(async(_,opt)=>{calls++;if(calls===2)throw Error('connection lost');return asResponse(response(JSON.parse(opt.body).questionId));},{persist:async j=>{durable=snapshotJob(j);}}));
 const restored=await importBackup(durable);assert.ok(restored.tasks[0].result);assert.equal(restored.tasks[1].state,'uncertain');assert.equal(restored.spentCny,.01);assert.equal(restored.heldCny,5);
 await rebindJob(restored,files());let nextCalls=0;await runJob(restored,runnerOptions(async()=>{nextCalls++;throw Error('unexpected');}));assert.equal(nextCalls,0);
});

test('failed response storage leaves durable in-flight request uncertain after restart',async()=>{
 const job=await createJob(pack(),files());let durable,calls=0;
 await assert.rejects(()=>runJob(job,runnerOptions(async(_,opt)=>{calls++;return asResponse(response(JSON.parse(opt.body).questionId));},{persist:async j=>{if(j.tasks[0].attempts[0]?.response)throw Error('storage full');durable=snapshotJob(j);}})),/storage full/);
 assert.equal(calls,1);const restored=await importBackup(durable);assert.equal(restored.tasks[0].state,'uncertain');assert.equal(restored.heldCny,5);assert.equal(restored.tasks[0].result,null);
});

function preparationDraft(overrides={}){
 const draft={...pack(),approved_by:''};
 return {id:'prepare-latest',kind:'prepare',state:'done',response:{pack:draft,warnings:[],ready:true},...overrides};
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
 for(const mutate of [x=>x.response.pack.approved_by='automatically approved',x=>x.response.pack.demo=true,x=>x.response.warnings=[''],x=>x.response.warnings=['x'.repeat(2001)],x=>x.response.warnings='missing',x=>x.response.pack.questions[0].max_score=99,x=>x.kind='grade']){
  const latest=preparationDraft();mutate(latest);assert.equal(restorePreparationDraft([latest]),null);
 }
});

// Full student PDFs use a separate identity ledger and immutable document IDs.
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {createStudentPDFJob as createDefaultStudentPDFJob,studentDisplay,documentForTask,taskAdvice,resolveStudentIdentity,retryStudentIdentity,refreshIdentityMappings,studentPDFDemoJob} from '../lib/grading/browser-workflow.mjs';
async function studentPDF(name='0012345678.pdf',count=3,tag='sample'){
 const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2000-01-01T00:00:00Z'));pdf.setModificationDate(new Date('2000-01-01T00:00:00Z'));const font=await pdf.embedFont(StandardFonts.Helvetica);
 for(let i=0;i<count;i++){const p=pdf.addPage([595,842]);p.drawText((i===0?'PRIVATE IDENTITY ':'ANSWER Q'+i+' ')+tag,{x:30,y:700,size:20,font});}
 return new File([await pdf.save({useObjectStreams:false})],name,{type:'application/pdf'});
}
const identity=(id='0012345678',name='测试甲')=>({name,student_id:id,name_status:name===null?'unreadable':'readable',student_id_status:id===null?'unreadable':'readable',warnings:[]});
function pdfResponder(identities){let i=0;return async(url,options)=>{if(url==='/api/identity')return asResponse({identity:identities[i++],estimatedCny:.01});return asResponse(response(JSON.parse(options.body).questionId));};}

test('student PDF maps only answer pages to tasks and identity before all grades',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()]);const doc=job.documents[0];
 assert.equal(job.inputMode,'student_pdf');assert.equal(doc.pageCount,3);assert.equal(doc.cover.sourcePage,1);assert.equal(job.tasks[0].pages[0].sourcePage,2);assert.equal(job.tasks[1].pages[0].sourcePage,3);
 let calls=[];await runJob(job,runnerOptions(async(url,options)=>{
  calls.push(url);const body=JSON.parse(options.body);
  if(url==='/api/identity'){assert.notEqual(body.page.sha256,doc.cover.sha256);assert.equal(body.page.mime,'image/jpeg');assert.equal(body.page.name,'identity-page.jpeg');assert.equal(stored.at(-1).documents[0].attempts[0].inputs[0].sourceSha256,doc.cover.sha256);assert.equal(stored.at(-1).documents[0].attempts[0].state,'in_flight');return asResponse({identity:identity(),estimatedCny:.01});}
  assert.ok(body.pages.every(p=>p.sha256!==doc.cover.sha256));assert.ok(!options.body.includes('0012345678'));assert.ok(!options.body.includes('测试甲'));return asResponse(response(body.questionId));
 }));
 assert.deepEqual(calls,['/api/identity','/api/grade','/api/grade']);assert.equal(job.spentCny,.03);assert.equal(job.heldCny,0);assert.equal(doc.studentId,'0012345678');assert.equal(doc.name,'测试甲');assert.equal(taskAdvice(job,job.tasks[0]).total,3);
 assert.match(exportCSV(job),/姓名/);assert.match(exportCSV(job),/测试甲/);assert.match(exportCSV(job),/0012345678/);
});

test('all covers are identified before answers so duplicate IDs block both documents',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF('scan-a.pdf',3,'a'),await studentPDF('scan-b.pdf',3,'b')]);let grades=0;
 await runJob(job,runnerOptions(async(url,options)=>{if(url==='/api/identity')return asResponse({identity:identity(),estimatedCny:.01});grades++;return asResponse(response(JSON.parse(options.body).questionId));}));
 assert.equal(grades,0);assert.ok(job.documents.every(d=>d.mappingStatus==='duplicate'));assert.ok(job.tasks.every(t=>taskAdvice(job,t).total===null));assert.match(exportCSV(job),/学号重复/);
 resolveStudentIdentity(job,job.documents[1].id,{studentId:'0012345679',name:'测试乙'});assert.ok(job.documents.every(d=>d.mappingStatus==='ready'));
 const resumed=await runJob(job,runnerOptions(pdfResponder([])));assert.equal(resumed.requests,4);assert.equal(job.documents[1].identityHistory.length,1);
});

test('filename omission uses readable cover ID; unreadable name stays blank without blocking',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF('scan.pdf')]);await runJob(job,runnerOptions(pdfResponder([identity('00001234',null)])));
 const display=studentDisplay(job,job.tasks[0]);assert.equal(display.studentId,'00001234');assert.equal(display.name,'');assert.equal(display.status,'ready');assert.equal(taskAdvice(job,job.tasks[0]).total,3);assert.match(exportCSV(job),/姓名未能辨认/);
});

test('filename and recognized ID disagreement blocks scores until explicit identity correction',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()]);let grade=0;await runJob(job,runnerOptions(async(url)=>{if(url!=='/api/identity')grade++;return asResponse({identity:identity('0012345679'),estimatedCny:.01});}));
 assert.equal(grade,0);assert.equal(job.documents[0].mappingStatus,'conflict');assert.equal(taskAdvice(job,job.tasks[0]).total,null);
 resolveStudentIdentity(job,job.documents[0].id,{studentId:'0012345679',name:'核对姓名'});assert.equal(job.documents[0].mappingStatus,'ready');assert.equal(studentDisplay(job,job.tasks[0]).name,'核对姓名');
 assert.throws(()=>resolveStudentIdentity(job,job.documents[0].id,{studentId:'1E10',name:''}),/身份/);
});

test('unreadable cover ID falls back to numeric filename; both missing require manual identity',async()=>{
 const files=[await studentPDF(),await studentPDF('scan.pdf',3,'b')];const job=await createStudentPDFJob(pack(),files);await runJob(job,runnerOptions(pdfResponder([identity(null),identity(null)])));
 assert.equal(job.documents[0].mappingStatus,'ready');assert.equal(job.documents[1].mappingStatus,'missing_id');assert.equal(job.tasks.filter(t=>t.result).length,2);
});

test('wrong page count is isolated and an absent roster student is retained in export',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF('0012345678.pdf',2),await studentPDF('0012345679.pdf',3,'valid')],{},['0012345678','0012345679','0012345680']);
 await runJob(job,runnerOptions(pdfResponder([identity('0012345679')])));
 assert.ok(job.documents[0].inputError);assert.equal(job.tasks[0].pages.length,0);assert.equal(job.tasks[0].result,null);assert.equal(job.tasks[2].result.question_id,'Q1');assert.match(exportCSV(job),/0012345680/);assert.match(exportCSV(job),/未收到PDF/);
});

test('PDF identity ledger survives uncertain network response and never retries implicitly',async()=>{
 const originals=[await studentPDF()];const job=await createStudentPDFJob(pack(),originals);let calls=0;let out=await runJob(job,runnerOptions(async()=>{calls++;throw Error('lost');}));
 assert.equal(out.paused,true);assert.equal(calls,1);assert.equal(job.heldCny,5);assert.equal(job.documents[0].identityState,'uncertain');assert.ok(job.tasks.every(t=>!t.attempts.length));
 const restored=await importBackup(snapshotJob(job));await rebindJob(restored,originals);assert.equal(restored.documents[0].cover.file.size,job.documents[0].cover.size);
 out=await runJob(restored,runnerOptions(async()=>{calls++;}));assert.equal(out.requests,0);assert.equal(calls,1);
 assert.throws(()=>retryStudentIdentity(restored,restored.documents[0].id),/再次计费/);retryStudentIdentity(restored,restored.documents[0].id,true);
 await runJob(restored,runnerOptions(pdfResponder([identity()])));assert.equal(restored.heldCny,5);assert.equal(restored.spentCny,.03);assert.equal(restored.documents[0].attempts.length,2);
});

test('saved identity response is recovered after interruption without another identity request',async()=>{
 const originals=[await studentPDF()];const job=await createStudentPDFJob(pack(),originals);let durable;
 await assert.rejects(()=>runJob(job,runnerOptions(pdfResponder([identity()]),{persist:async j=>{durable=snapshotJob(j);if(j.documents[0].attempts[0]?.state==='response_saved')throw Error('save interrupted');}})),/interrupted/);
 const restored=await importBackup(durable);await rebindJob(restored,originals);let ids=0;
 await runJob(restored,runnerOptions(async(url,options)=>{if(url==='/api/identity')ids++;return asResponse(response(JSON.parse(options.body).questionId));}));
 assert.equal(ids,0);assert.equal(restored.documents[0].identityState,'done');assert.equal(restored.documents[0].name,'测试甲');assert.equal(restored.spentCny,.03);
});

test('PDF snapshots omit original and lazy pages, preserve names and reject mismatched mapping or ledger',async()=>{
 const original=await studentPDF();const job=await createStudentPDFJob(pack(),[original]);await runJob(job,runnerOptions(pdfResponder([identity()])));job.apiKey='secret-raw-key';
 const snapshot=snapshotJob(job);assert.equal(snapshot.formatVersion,3);assert.equal(snapshot.documents[0].file,undefined);assert.equal(snapshot.documents[0].cover.file,undefined);assert.equal(snapshot.documents[0].answerPages[0].file,undefined);assert.ok(!JSON.stringify(snapshot).includes('secret-raw-key'));
 const restored=await importBackup(snapshot);assert.equal(restored.documents[0].name,'测试甲');assert.equal(restored.documents[0].cover.file,undefined);
 assert.throws(()=>resolveStudentIdentity(restored,restored.documents[0].id,{studentId:'123',name:''}),/原PDF/);
 for(const mutate of [x=>x.tasks[0].pages[0].sourcePage=1,x=>x.documents[0].cover.sourcePage=2,x=>x.spentCny=0,x=>x.documents[0].identityResult.student_id='bad',x=>x.documents[0].answerPages.pop(),x=>x.documents[0].id='different',x=>x.documents[0].filenameStudentId='7777',x=>x.documents[0].cover.path='other/page-001.pdf',x=>x.documents[0].identityResult.name='changed',x=>{x.documents[0].attempts[0].costCny=.02;x.spentCny+=.01;}]){const bad=structuredClone(snapshot);mutate(bad);await assert.rejects(()=>importBackup(bad));}
 const changedPDF=await studentPDF('0012345678.pdf',3,'changed');await assert.rejects(()=>rebindJob(restored,[changedPDF]),/改变/);
});

test('PDF stale tab restores identity and file handles without duplicate charges',async()=>{
 const originals=[await studentPDF()],first=await createStudentPDFJob(pack(),originals),second=await importBackup(snapshotJob(first));await rebindJob(second,originals);
 await runJob(first,runnerOptions(pdfResponder([identity()])));let calls=0;
 await runJob(second,runnerOptions(async()=>{calls++;},{load:async()=>importBackup(snapshotJob(first))}));assert.equal(calls,0);assert.equal(studentDisplay(second,second.tasks[0]).name,'测试甲');assert.ok(second.documents[0].cover.file);
});

test('identity budget and storage failures prevent a first network call',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()],{budgetCny:5,requestReserveCny:5});job.heldCny=5;let calls=0;
 await assert.rejects(()=>runJob(job,runnerOptions(async()=>{calls++;})),/预算/);assert.equal(calls,0);
 const fresh=await createStudentPDFJob(pack(),[await studentPDF()]);await assert.rejects(()=>runJob(fresh,runnerOptions(async()=>{calls++;},{persist:async()=>{throw Error('storage full');}})),/storage/);assert.equal(calls,0);
});

test('out-of-roster identification cannot expose an accepted score',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()],{},['999999']);await runJob(job,runnerOptions(pdfResponder([identity()])));assert.equal(job.documents[0].mappingStatus,'roster_mismatch');assert.equal(taskAdvice(job,job.tasks[0]).total,null);assert.match(exportCSV(job),/名单外学号/);
});

test('full PDF demo uses synthetic identities with no network and deterministic rebind',async()=>{
 const job=await studentPDFDemoJob();let calls=0;await runJob(job,runnerOptions(async()=>{calls++;throw Error('must not call');}));assert.equal(calls,0);assert.equal(job.spentCny,0);assert.equal(job.documents[0].name,'演示甲');assert.ok(job.tasks.every(t=>t.result));
 const restored=await importBackup(snapshotJob(job)),fresh=await studentPDFDemoJob();await rebindJob(restored,fresh.documents.map(d=>d.file));assert.ok(restored.documents[0].cover.file);assert.match(exportCSV(restored),/演示甲/);
});


test('PDF mode refuses reordered questions and invalid roster before reading originals',async()=>{
 const altered=pack();altered.questions.reverse();let reads=0;const original={name:'123.pdf',size:100,arrayBuffer:async()=>{reads++;throw Error('should not read');}};
 await assert.rejects(()=>createStudentPDFJob(altered,[original]),/顺序/);
 await assert.rejects(()=>createStudentPDFJob(pack(),[original],{},['123','123']),/不重复/);assert.equal(reads,0);
});

test('identity invalid JSON shape retains reserve and pauses before scoring',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()]);let calls=0;
 const result=await runJob(job,runnerOptions(async()=>{calls++;return asResponse(null);}));assert.equal(calls,1);assert.equal(result.paused,true);assert.equal(job.heldCny,5);assert.equal(job.documents[0].identityState,'uncertain');assert.ok(job.tasks.every(t=>!t.attempts.length));
 const restored=await importBackup(snapshotJob(job));assert.equal(restored.documents[0].identityState,'uncertain');
});

test('identity quota errors pause and require explicit retry without reserving an unused fee',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()]);let calls=0;
 const result=await runJob(job,runnerOptions(async()=>{calls++;return asResponse({error:'slow down',code:'RATE_LIMIT',uncertain:false},429);}));assert.equal(result.paused,true);assert.equal(job.heldCny,0);assert.equal(job.documents[0].identityState,'error');
 await runJob(job,runnerOptions(async()=>{calls++;}));assert.equal(calls,1);retryStudentIdentity(job,job.documents[0].id);await runJob(job,runnerOptions(pdfResponder([identity()])));assert.equal(job.spentCny,.03);
});

test('identity edits after grading preserve document-bound scores and block any new duplicate association',async()=>{
 const originals=[await studentPDF('0012345678.pdf',3,'first'),await studentPDF('0012345679.pdf',3,'second')];
 const job=await createStudentPDFJob(pack(),originals);await runJob(job,runnerOptions(pdfResponder([identity(),identity('0012345679','测试乙')])));
 const ids=job.tasks.map(t=>t.id),rawResults=JSON.stringify(job.tasks.map(t=>t.result)),rawIdentities=JSON.stringify(job.documents.map(d=>d.identityResult));
 resolveStudentIdentity(job,job.documents[0].id,{studentId:'0012345678',name:'更正姓名'});assert.equal(taskAdvice(job,job.tasks[0]).total,3);assert.match(exportCSV(job),/更正姓名/);
 resolveStudentIdentity(job,job.documents[1].id,{studentId:'0012345678',name:''});assert.ok(job.tasks.every(t=>taskAdvice(job,t).total===null));assert.ok(job.documents.every(d=>d.mappingStatus==='duplicate'));
 const restored=await importBackup(snapshotJob(job));assert.deepEqual(restored.tasks.map(t=>t.id),ids);assert.equal(JSON.stringify(restored.tasks.map(t=>t.result)),rawResults);assert.equal(JSON.stringify(restored.documents.map(d=>d.identityResult)),rawIdentities);
 await rebindJob(restored,originals);resolveStudentIdentity(restored,restored.documents[1].id,{studentId:'0012345679',name:''});assert.ok(restored.tasks.every(t=>taskAdvice(restored,t).total===3));let calls=0;
 await runJob(restored,runnerOptions(async()=>{calls++;throw Error('completed grading must be reused');}));assert.equal(calls,0);assert.equal(restored.documents[1].identityHistory.length,2);assert.equal(restored.documents[1].name,null);
});


test('name-unreadable notice appears only after identity completion, never before an attempted reading',async()=>{
 const job=await createStudentPDFJob(pack(),[await studentPDF()]),doc=job.documents[0];
 for(const state of ['pending','running','error','uncertain']){doc.identityState=state;refreshIdentityMappings(job);assert.ok(!doc.identityWarnings.some(w=>/姓名未能辨认|姓名未填写/.test(w)));}
 doc.identityState='done';doc.identityResult=identity('0012345678',null);refreshIdentityMappings(job);assert.ok(doc.identityWarnings.some(w=>/姓名未能辨认/.test(w)));
 resolveStudentIdentity(job,doc.id,{studentId:'0012345678',name:''});assert.ok(doc.identityWarnings.some(w=>/姓名未填写/.test(w)));assert.ok(!doc.identityWarnings.some(w=>/姓名未能辨认/.test(w)));
});


test('current settings default to four simultaneous requests and reject invalid concurrency',async()=>{
 assert.equal(DEFAULT_SETTINGS.concurrency,4);assert.ok(!Object.hasOwn(DEFAULT_SETTINGS,'requestsPerMinute'));
 for(const concurrency of [0,-1,1.5,5,'4',NaN])await assert.rejects(()=>createJob(pack(),files(),{concurrency}),/并发/);
});
test('only current backup format is accepted without conversion',async()=>{
 const backup=snapshotJob(await createJob(pack(),files()));assert.equal(backup.formatVersion,3);
 for(const formatVersion of [1,2])await assert.rejects(()=>importBackup({...backup,formatVersion}),/旧备份不会被转换/);
 const task=backup.tasks[0];assert.ok(Object.hasOwn(task,'result'));assert.ok(!Object.hasOwn(task,'results'));
});


test('older uploaded backup cannot replace the current local paid request ledger',async()=>{
 const job=await createJob(pack(),files()),old=snapshotJob(job);
 await runJob(job,runnerOptions(async(_,opt)=>asResponse(response(JSON.parse(opt.body).questionId))));
 let writes=0;
 const recovered=await restoreBackupSafely(old,{locks,load:async id=>{assert.equal(id,job.id);return importBackup(snapshotJob(job));},persist:async current=>{writes++;assert.equal(current.id,job.id);assert.equal(current.spentCny,.02);assert.ok(current.tasks.every(t=>t.result));}});
 assert.equal(recovered.usedLocal,true);assert.equal(writes,1);assert.ok(recovered.job.tasks.every(t=>t.result));assert.equal(recovered.job.spentCny,.02);
 await rebindJob(recovered.job,files());let calls=0;await runJob(recovered.job,runnerOptions(async()=>{calls++;}));assert.equal(calls,0);
});
test('backup restore persists a new batch only after acquiring browser and batch locks',async()=>{
 const backup=snapshotJob(await createJob(pack(),files())),acquired=[];let writes=0;
 const checkedLocks={request:async(name,opts,fn)=>{acquired.push(name);assert.equal(opts.ifAvailable,true);return fn({name});}};
 const restored=await restoreBackupSafely(backup,{locks:checkedLocks,load:async()=>null,persist:async j=>{writes++;assert.equal(j.id,backup.id);}});
 assert.equal(restored.usedLocal,false);assert.equal(writes,1);assert.deepEqual(acquired,['grading-runner','grading-job:'+backup.id]);
 await assert.rejects(()=>restoreBackupSafely(backup,{locks:{request:async(_,__,fn)=>fn(null)},load:async()=>{throw Error('must not load');},persist:async()=>{throw Error('must not save');}}),/另一个页面/);
});


test('identical teaching document hashes reuse the latest completed preparation without mutation',()=>{
 const documentHashes={paper:'a'.repeat(64),solution:'b'.repeat(64),rubric:'c'.repeat(64)},latest=preparationDraft();latest.response.documentHashes={...documentHashes};
 const recovered=restorePreparationDraft([latest],{documentHashes});assert.ok(recovered);assert.equal(recovered.ready,true);assert.equal(recovered.pack.title,latest.response.pack.title);
 recovered.pack.title='changed';assert.notEqual(recovered.pack.title,latest.response.pack.title);assert.ok(!Object.hasOwn(recovered,'documentHashes'));
});
test('changed missing or malformed teaching document hashes cannot reuse a preparation',()=>{
 const documentHashes={paper:'a'.repeat(64),solution:'b'.repeat(64),rubric:'c'.repeat(64)},latest=preparationDraft();latest.response.documentHashes={...documentHashes};
 for(const role of Object.keys(documentHashes))assert.equal(restorePreparationDraft([latest],{documentHashes:{...documentHashes,[role]:'d'.repeat(64)}}),null);
 for(const hashes of [null,[],{}, {...documentHashes,extra:'e'.repeat(64)}, {...documentHashes,paper:'not-a-sha'}])assert.equal(restorePreparationDraft([latest],{documentHashes:hashes}),null);
 delete latest.response.documentHashes;assert.equal(restorePreparationDraft([latest],{documentHashes}),null);assert.ok(restorePreparationDraft([latest]));
});
