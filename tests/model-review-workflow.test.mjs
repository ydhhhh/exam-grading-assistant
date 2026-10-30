import {renderPDF} from './helpers/pdf-rendering.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createJob,studentPDFDemoJob,runJob,taskAdvice,getModelReviewSummary,reviewTask,snapshotJob,importBackup,rebindJob,hashJSON,exportCSV} from '../lib/grading/browser-workflow.mjs';

import {getDefaultProfile,DEFAULT_STAGE_PROFILES} from '../lib/grading/providers.mjs';
const profile=getDefaultProfile('kimi','review');
const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nN8AAAAASUVORK5CYII='),c=>c.charCodeAt(0));
const files=(n=2)=>Array.from({length:n},(_,i)=>new File([png,String(i)],`S${i+1}_Q1_01.png`,{type:'image/png'}));
const pack={exam_id:'MODELREVIEW',title:'Synthetic review test',version:'1',demo:false,approved_by:'Synthetic teacher',policies:'Synthetic test only.',questions:[{question_id:'Q1',text:'Synthetic',solution:'Synthetic',max_score:4,criteria:[{criterion_id:'C1',description:'A',allowed_scores:[0,1,2],requires:[]},{criterion_id:'C2',description:'B',allowed_scores:[0,1,2],requires:[]}]}]};
const score=(values=[1,2])=>({question_id:'Q1',status:'scored',criteria:values.map((awarded,i)=>({criterion_id:'C'+(i+1),awarded,evidence_refs:['P1'],reason:'Synthetic evidence'})),flags:[],alternative_solution:false});
const response=(body,review=false,values)=>({result:score(values),provider:review?body.reviewProfile.provider:body.stageProfiles.grade.provider,stageProfile:body.stageProfiles[review?'review':'grade'],requestId:body.requestId,estimatedCny:review?.02:.01,usage:{input_tokens:100,output_tokens:100},...(review?{reviewProfile:body.reviewProfile,initialResultHash:body.initialResultHash}:{} )});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status});
const options=(fetcher,extra={})=>({renderPDF,apiKey:'sk-synthetic-DO-NOT-STORE',reviewApiKey:'review-key-synthetic-only',fetcher,persist:async()=>{},load:async()=>null,locks:{request:async(_,__,fn)=>fn({})},...extra});
const job=async(n=2,settings={})=>createJob(pack,files(n),{reviewProfile:structuredClone(profile),concurrency:1,...settings});
const normal=async(url,opt)=>{const body=JSON.parse(opt.body);return json(response(body,url==='/api/review'));};

test('review stage sends original anonymous evidence and binds initial result/profile after grading',async()=>{
  const j=await job();const calls=[],saved=[];
  const out=await runJob(j,options(async(url,opt)=>{
    const b=JSON.parse(opt.body);calls.push(url);assert.equal(opt.credentials,'same-origin');assert.ok(!opt.body.includes('S1'));
    if(url==='/api/review'){
      assert.deepEqual(b.initialResult,score());assert.equal(b.initialResultHash,await hashJSON(score()));assert.deepEqual(b.reviewProfile,profile);
      const task=saved.at(-1).tasks.find(t=>t.reviewAttempts.some(a=>a.id===b.requestId));assert.equal(task.reviewAttempts.at(-1).state,'in_flight');assert.equal(task.result.status,'scored');
      assert.equal(b.pages[0].sha256,task.pages[0].sha256);
    }
    return json(response(b,url==='/api/review'));
  },{persist:async value=>saved.push(snapshotJob(value))}));
  assert.deepEqual(calls,['/api/grade','/api/grade','/api/review','/api/review']);assert.equal(out.requests,4);assert.equal(j.spentCny,.06);assert.equal(j.heldCny,0);
  assert.ok(j.tasks.every(t=>t.attempts.length===1&&t.reviewAttempts.length===1&&getModelReviewSummary(t).status==='agreed'));
  assert.equal(taskAdvice(j,j.tasks[0]).source,'ai_review');assert.equal(taskAdvice(j,j.tasks[0]).total,3);
  const restored=await importBackup(snapshotJob(j));await rebindJob(restored,files());assert.equal((await runJob(restored,options(()=>{throw Error('replayed');}))).requests,0);
  assert.ok(!JSON.stringify(snapshotJob(j)).includes('sk-synthetic'));
});

test('equal question totals keep the score and preserve different criterion awards',async()=>{
  const j=await job(1);await runJob(j,options(async(url,opt)=>json(response(JSON.parse(opt.body),url==='/api/review',url==='/api/review'?[2,1]:[1,2]))));
  const t=j.tasks[0],summary=getModelReviewSummary(t);assert.equal(summary.initialTotal,3);assert.equal(summary.reviewTotal,3);assert.equal(summary.status,'agreed');assert.equal(taskAdvice(j,t).total,3);assert.equal(taskAdvice(j,t).scores,null);
  assert.deepEqual(summary.differences,['C1','C2']);assert.match(exportCSV(j),/Q1初评分/);assert.doesNotMatch(exportCSV(j),/MODEL_REVIEW_DISAGREEMENT/);
  const restored=await importBackup(snapshotJob(j));assert.equal(taskAdvice(restored,restored.tasks[0]).total,3);
  reviewTask(t,{C1:2,C2:0},'Synthetic reviewer','');assert.equal(taskAdvice(j,t).source,'human');assert.equal(taskAdvice(j,t).total,2);assert.equal(getModelReviewSummary(t).status,'agreed');await importBackup(snapshotJob(j));
});

test('review disabled jobs retain single stage and do not gain review fields on restore',async()=>{
  const j=await createJob(pack,files(1),{reviewProfile:null});await runJob(j,options(normal));const restored=await importBackup(snapshotJob(j));assert.equal(restored.tasks[0].modelReviewState,undefined);assert.equal(taskAdvice(restored,restored.tasks[0]).source,'ai');
});

test('managed credentials are never required or sent by client',async()=>{
  const j=await job(1,{credentialMode:'managed'});await runJob(j,options(async(url,opt)=>{assert.equal(opt.headers['X-Api-Key'],undefined);return normal(url,opt);},{apiKey:'',reviewApiKey:''}));assert.equal(j.tasks[0].modelReviewState,'done');
});

test('review network failure preserves initial result and reserve, never retries',async()=>{
  const j=await job();let reviews=0;await runJob(j,options(async(url,opt)=>{if(url==='/api/review'){reviews++;throw Error('network');}return normal(url,opt);}));
  assert.equal(j.tasks[0].result.status,'scored');assert.equal(j.tasks[0].modelReview,null);assert.equal(j.tasks[0].modelReviewState,'uncertain');assert.equal(j.heldCny,5);assert.equal(j.tasks[1].modelReviewState,'pending');assert.equal(taskAdvice(j,j.tasks[0]).total,null);
  const restored=await importBackup(snapshotJob(j));await rebindJob(restored,files());await runJob(restored,options(async(url,opt)=>{reviews++;return normal(url,opt);}));assert.equal(reviews,2);assert.equal(restored.tasks[0].reviewAttempts.length,1);assert.equal(restored.heldCny,5);
});

test('review response with missing usage preserves result and hold and pauses remaining review',async()=>{
  const j=await job();await runJob(j,options(async(url,opt)=>{const b=JSON.parse(opt.body),r=response(b,url==='/api/review');if(url==='/api/review')r.estimatedCny=null;return json(r);}));
  assert.equal(j.tasks[0].modelReviewState,'done');assert.equal(j.tasks[1].modelReviewState,'pending');assert.equal(j.heldCny,5);await importBackup(snapshotJob(j));
});

test('review response hash/profile substitution is not adopted and keeps reserve',async()=>{
  for(const change of [r=>r.initialResultHash='0'.repeat(64),r=>r.reviewProfile.model='different-model',r=>delete r.reviewProfile]){
    const j=await job(1);await runJob(j,options(async(url,opt)=>{const b=JSON.parse(opt.body),r=response(b,url==='/api/review');if(url==='/api/review')change(r);return json(r);}));
    assert.equal(j.tasks[0].modelReview,null);assert.equal(j.tasks[0].modelReviewState,'uncertain');assert.equal(j.heldCny,5);assert.equal(j.spentCny,.01);await importBackup(snapshotJob(j));
  }
});

test('review invalid score consumes returned fee but never overwrites initial score',async()=>{
  const j=await job(1);await runJob(j,options(async(url,opt)=>json(response(JSON.parse(opt.body),url==='/api/review',url==='/api/review'?[99,2]:[1,2]))));
  assert.equal(j.tasks[0].result.criteria[0].awarded,1);assert.equal(j.tasks[0].modelReview,null);assert.equal(j.tasks[0].modelReviewState,'error');assert.equal(j.spentCny,.03);assert.equal(taskAdvice(j,j.tasks[0]).total,null);await importBackup(snapshotJob(j));
});

test('review saved response recovers after interruption without resending',async()=>{
  const j=await job(1);let durable;
  await assert.rejects(()=>runJob(j,options(normal,{persist:async value=>{if(value.tasks[0].reviewAttempts[0]?.state==='response_saved'){durable=snapshotJob(value);throw Error('synthetic storage crash');}}})),/storage crash/);
  const restored=await importBackup(durable);await rebindJob(restored,files(1));const out=await runJob(restored,options(()=>{throw Error('duplicate review');}));assert.equal(out.requests,0);assert.equal(restored.tasks[0].modelReviewState,'done');assert.equal(restored.spentCny,.03);
});

test('review inflight snapshot restores uncertain without discarding initial result',async()=>{
  const j=await job(1);let durable;await runJob(j,options(async(url,opt)=>{if(url==='/api/review'){durable=snapshotJob(j);throw Error('closed');}return normal(url,opt);}));
  const restored=await importBackup(durable);assert.equal(restored.tasks[0].modelReviewState,'uncertain');assert.equal(restored.tasks[0].result.status,'scored');assert.equal(restored.heldCny,5);
});

test('backup rejects changed initial result, reviewer profile, response, ledger and replay count',async()=>{
  const j=await job(1);await runJob(j,options(normal));const original=snapshotJob(j);
  for(const change of [x=>x.tasks[0].reviewAttempts[0].initialResultHash='f'.repeat(64),x=>x.tasks[0].modelReview.criteria[0].awarded=2,x=>x.tasks[0].reviewAttempts[0].reviewProfile.model='wrong',x=>x.tasks[0].reviewAttempts[0].response.reviewProfile.model='wrong',x=>x.tasks[0].reviewAttempts[0].costCny=0,x=>x.tasks[0].reviewAttempts.push({...structuredClone(x.tasks[0].reviewAttempts[0]),id:'duplicate-stage'}),x=>delete x.tasks[0].modelReviewState]){
    const data=structuredClone(original);change(data);await assert.rejects(()=>importBackup(data));
  }
});

test('review budget includes initial spend and prevents unreserved review requests',async()=>{
  const j=await job(1,{budgetCny:5,requestReserveCny:5});let calls=0;await assert.rejects(()=>runJob(j,options(async(url,opt)=>{calls++;return normal(url,opt);})),/预算/);assert.equal(calls,1);assert.equal(j.tasks[0].reviewAttempts.length,0);assert.equal(taskAdvice(j,j.tasks[0]).total,null);
});

test('review stage keeps at most four in flight and serializes every durable save',async()=>{
  const j=await job(7,{concurrency:4});let active=0,peak=0,saving=0;await runJob(j,options(async(url,opt)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,4));active--;return normal(url,opt);},{persist:async()=>{saving++;assert.equal(saving,1);await new Promise(r=>setTimeout(r,1));saving--;}}));assert.ok(peak>1&&peak<=4);assert.equal(j.tasks.reduce((n,t)=>n+t.reviewAttempts.length,0),7);assert.equal(j.heldCny,0);
});

test('PDF demo models agreement and a merged score without network or fees',async()=>{
  const j=await studentPDFDemoJob({reviewProfile:profile});await runJob(j,options(()=>{throw Error('network forbidden');}));assert.equal(j.spentCny,0);assert.equal(j.heldCny,0);assert.equal(getModelReviewSummary(j.tasks[0]).status,'adjusted');assert.equal(taskAdvice(j,j.tasks[0]).total,5);assert.ok(j.tasks.slice(1).every(t=>getModelReviewSummary(t).status==='agreed'));assert.match(exportCSV(j),/模型复核状态/);await importBackup(snapshotJob(j));
});

test('pause after review reservation releases unsent hold and manual resume sends only once',async()=>{
  const j=await job(1);let paused=false,reviewCalls=0;
  await runJob(j,options(async(url,opt)=>{if(url==='/api/review')reviewCalls++;return normal(url,opt);},{shouldStop:()=>paused,persist:async value=>{if(value.tasks[0].reviewAttempts.at(-1)?.state==='in_flight')paused=true;}}));
  assert.equal(reviewCalls,0);assert.equal(j.heldCny,0);assert.equal(j.tasks[0].reviewAttempts[0].notSent,true);assert.equal(j.tasks[0].modelReviewState,'pending');
  const restored=await importBackup(snapshotJob(j));await rebindJob(restored,files(1));await runJob(restored,options(async(url,opt)=>{if(url==='/api/review')reviewCalls++;return normal(url,opt);}));assert.equal(reviewCalls,1);assert.equal(restored.tasks[0].reviewAttempts.length,2);await importBackup(snapshotJob(restored));
});

test('cross-provider test review uses separate ephemeral key and keeps both out of saved response',async()=>{
  const alternate=getDefaultProfile('qwen','review'),j=await job(1,{reviewProfile:alternate});
  await runJob(j,options(async(url,opt)=>{
    const b=JSON.parse(opt.body);assert.equal(opt.headers['X-Api-Key'],url==='/api/review'?'review-secret-DO-NOT-STORE':'sk-synthetic-DO-NOT-STORE');assert.equal(opt.headers['X-Api-Provider'],url==='/api/review'?'qwen':'deepseek');
    return json({...response(b,url==='/api/review'),raw:'review-secret-DO-NOT-STORE sk-synthetic-DO-NOT-STORE'});
  },{reviewApiKey:'review-secret-DO-NOT-STORE'}));
  const saved=JSON.stringify(snapshotJob(j));assert.ok(!saved.includes('review-secret-DO-NOT-STORE'));assert.ok(!saved.includes('sk-synthetic-DO-NOT-STORE'));await importBackup(snapshotJob(j));
});

test('missing or blank cross-provider review key pauses before review reservation',async()=>{
  for(const reviewApiKey of ['', '   ']){
    const j=await job(1,{reviewProfile:getDefaultProfile('qwen','review')});const calls=[];
    const first=await runJob(j,options(async(url,opt)=>{calls.push(url);return normal(url,opt);},{reviewApiKey}));
    assert.deepEqual(calls,['/api/grade']);assert.equal(first.paused,true);assert.match(first.reason,/第三步密钥/);
    assert.equal(j.tasks[0].result.status,'scored');assert.equal(j.tasks[0].modelReviewState,'pending');assert.equal(j.tasks[0].reviewAttempts.length,0);assert.equal(j.heldCny,0);assert.equal(j.spentCny,.01);assert.equal(taskAdvice(j,j.tasks[0]).total,null);
    const again=await runJob(j,options(()=>{throw Error('missing key must not replay initial grading');},{reviewApiKey}));
    assert.equal(again.requests,0);assert.equal(again.paused,true);
  }
});

test('known review rejection retains initial score and fee, and cannot be silently resubmitted',async()=>{
  const j=await job(1);let calls=0;await runJob(j,options(async(url,opt)=>{if(url==='/api/review'){calls++;return json({error:'Synthetic service busy',uncertain:false,estimatedCny:0,code:'SERVER_BUSY'},429);}return normal(url,opt);}));
  assert.equal(j.heldCny,0);assert.equal(j.spentCny,.01);assert.equal(j.tasks[0].modelReviewState,'error');assert.equal(j.tasks[0].result.status,'scored');await runJob(j,options(()=>{calls++;throw Error('replay');}));assert.equal(calls,1);await importBackup(snapshotJob(j));
});

test('definitely unsent session/config failures pause and resume manually without repeating paid work',async()=>{
  for(const code of ['SESSION_REQUIRED','REVIEW_CONFIG_CHANGED','SERVER_BUSY']){
    const j=await job(1,{credentialMode:'managed'});let paidReviews=0;
    const first=await runJob(j,options(async(url,opt)=>url==='/api/review'?json({error:'Synthetic preflight failure',code,uncertain:false,notSent:true,estimatedCny:0},code==='SESSION_REQUIRED'?401:429):normal(url,opt)));
    assert.equal(first.paused,true);assert.equal(j.tasks[0].modelReviewState,'pending');assert.equal(j.tasks[0].reviewAttempts[0].notSent,true);assert.equal(j.spentCny,.01);assert.equal(j.heldCny,0);
    const restored=await importBackup(snapshotJob(j));await rebindJob(restored,files(1));await runJob(restored,options(async(url,opt)=>{assert.equal(url,'/api/review');paidReviews++;return normal(url,opt);}));assert.equal(paidReviews,1);assert.equal(restored.tasks[0].modelReviewState,'done');await importBackup(snapshotJob(restored));
  }
});

test('notSent claim with uncertain or nonzero cost cannot permit review replay',async()=>{
  for(const changes of [{uncertain:true},{estimatedCny:.02}]){
    const j=await job(1);await runJob(j,options(async(url,opt)=>url==='/api/review'?json({error:'Synthetic ambiguous failure',notSent:true,estimatedCny:0,uncertain:false,...changes},503):normal(url,opt)));
    assert.equal(j.tasks[0].reviewAttempts[0].notSent,undefined);assert.notEqual(j.tasks[0].modelReviewState,'pending');let calls=0;await runJob(j,options(async()=>{calls++;throw Error('retry');}));assert.equal(calls,0);
  }
});

test('server config-change provider on an explicitly unsent response retains zero fee and resumability',async()=>{
  const j=await job(1);await runJob(j,options(async(url,opt)=>url==='/api/review'?json({error:'Config changed before upstream call',provider:'deepseek',notSent:true,uncertain:false,estimatedCny:0},409):normal(url,opt)));
  assert.equal(j.heldCny,0);assert.equal(j.tasks[0].modelReviewState,'pending');assert.equal(j.tasks[0].reviewAttempts[0].notSent,true);
  // The mismatch is meaningful metadata about the current server, not a paid
  // response from the immutable profile originally requested by this batch.
  await importBackup(snapshotJob(j));
});

function csvRecords(csv){
  const rows=csv.trim().replace(/^\ufeff/,'').split('\r\n').map(line=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match=>match[1].replaceAll('""','"')));
  return rows.slice(1).map(row=>Object.fromEntries(rows[0].map((header,index)=>[header,row[index]])));
}

test('PDF CSV gives a human override precedence over the merged score while preserving 5 and 4',async()=>{
  const j=await studentPDFDemoJob({reviewProfile:profile});await runJob(j,options(()=>{throw Error('network forbidden');}));
  const t=j.tasks[0];assert.equal(getModelReviewSummary(t).initialTotal,5);assert.equal(getModelReviewSummary(t).reviewTotal,4);
  reviewTask(t,{C1:1,C2:3},'Synthetic teacher','');
  const row=csvRecords(exportCSV(j)).find(row=>row['学号']==='9000000001');
  assert.equal(row.Q1,'4');assert.equal(row['Q1初评分'],'5');assert.equal(row['Q1模型复核分'],'4');assert.match(row['Q1模型复核状态'],/已人工确认/);assert.ok(!row['Q1模型复核状态'].includes('待人工确认'));
  assert.equal(getModelReviewSummary(t).status,'adjusted');
});

test('CSV distinguishes human-confirmed pending failed and uncertain model review without clearing their state',async()=>{
  for(const state of ['pending','error','uncertain','unresolved']){
    const j=await job(1);
    await runJob(j,options(async(url,opt)=>{
      if(url==='/api/review'){
        if(state==='pending')return json({error:'Synthetic preflight',notSent:true,uncertain:false,estimatedCny:0},401);
        if(state==='error')return json({error:'Synthetic refusal',uncertain:false,estimatedCny:.02},422);
        if(state==='uncertain')throw Error('Synthetic disconnect');
        const b=JSON.parse(opt.body),r=response(b,true);r.result.status='needs_review';return json(r);
      }
      return normal(url,opt);
    }));
    const t=j.tasks[0];assert.equal(getModelReviewSummary(t).status,state);reviewTask(t,{C1:1,C2:2},'Synthetic teacher','');
    const row=csvRecords(exportCSV(j))[0];assert.equal(row.Q1,'3');assert.equal(row['Q1初评分'],'3');assert.match(row['Q1模型复核状态'],/已人工确认/);assert.equal(getModelReviewSummary(t).status,state);
    if(state==='uncertain'){assert.match(row['Q1模型复核状态'],/费用未定/);assert.equal(j.heldCny,5);}
  }
});

test('a suspected instruction in either round survives a clean high-score counterpart and backup until human confirmation',async()=>{
  for(const flaggedStage of ['/api/grade','/api/review']){
    const j=await job(1);
    await runJob(j,options(async(url,opt)=>{
      const r=response(JSON.parse(opt.body),url==='/api/review',[2,2]);
      if(url===flaggedStage){r.result.status='needs_review';r.result.flags=[{code:'UNTRUSTED_INSTRUCTION',detail:'Synthetic instruction concern; not a misconduct decision.',evidence_refs:['P1']}];}
      return json(r);
    }));
    assert.equal(taskAdvice(j,j.tasks[0]).total,null);
    const restored=await importBackup(snapshotJob(j));await rebindJob(restored,files(1));
    const t=restored.tasks[0];assert.equal(taskAdvice(restored,t).total,null);
    assert.equal(getModelReviewSummary(t).status,'unresolved');
    assert.ok(t.result.criteria.every(point=>point.awarded===2));
    assert.ok(t.modelReview.criteria.every(point=>point.awarded===2));
    reviewTask(t,{C1:2,C2:1},'Synthetic teacher','');
    assert.equal(taskAdvice(restored,t).total,3);
    assert.equal((flaggedStage==='/api/grade'?t.result:t.modelReview).flags[0].code,'UNTRUSTED_INSTRUCTION');
    assert.equal((await runJob(restored,options(()=>{throw Error('No replay after human confirmation');}))).requests,0);
    await importBackup(snapshotJob(restored));
  }
});


test('merged and large-difference scores survive export and backup without overwriting raw model results',async()=>{
  for(const [initial,review,total,status] of [[[0,1],[1,2],2,'adjusted'],[[0,1],[0,2],2,'adjusted'],[[0,0],[2,2],null,'disagreement']]){
    const j=await job(1);await runJob(j,options(async(url,opt)=>json(response(JSON.parse(opt.body),url==='/api/review',url==='/api/review'?review:initial))));
    const t=j.tasks[0],original=structuredClone({result:t.result,modelReview:t.modelReview});
    assert.equal(getModelReviewSummary(t).status,status);assert.equal(taskAdvice(j,t).total,total);
    const row=csvRecords(exportCSV(j))[0];assert.equal(row.Q1,total===null?'':String(total));assert.equal(row['Q1初评分'],String(initial[0]+initial[1]));assert.equal(row['Q1模型复核分'],String(review[0]+review[1]));
    const restored=await importBackup(snapshotJob(j)),rt=restored.tasks[0];assert.equal(taskAdvice(restored,rt).total,total);assert.equal(getModelReviewSummary(rt).status,status);assert.deepEqual({result:rt.result,modelReview:rt.modelReview},original);
    await rebindJob(restored,files(1));assert.equal((await runJob(restored,options(()=>{throw Error('Merge must not call a model again');}))).requests,0);
    reviewTask(rt,{C1:2,C2:2},'Synthetic teacher','');const manual=await importBackup(snapshotJob(restored));assert.equal(taskAdvice(manual,manual.tasks[0]).source,'human');assert.equal(taskAdvice(manual,manual.tasks[0]).total,4);
  }
});
