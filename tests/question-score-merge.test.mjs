import test from 'node:test';
import assert from 'node:assert/strict';
import {taskAdvice,getModelReviewSummary,reviewTask,exportCSV} from '../lib/grading/browser-workflow.mjs';
import {getTaskFlags} from '../lib/grading/result-filters.mjs';

// Synthetic, deterministic records: no network or provider credentials.
function gradedQuestion(initial,review,{id='Q1',max=10}={}){
  const question={question_id:id,text:'Synthetic question',solution:'Synthetic solution',max_score:max,criteria:[{criterion_id:'C1',description:'Synthetic criterion',allowed_scores:[...new Set([0,initial,review,max].filter(x=>x!==null))],requires:[]}]};
  const result=value=>({question_id:id,status:value===null?'needs_review':'scored',criteria:[{criterion_id:'C1',awarded:value,evidence_refs:['P1'],reason:'Synthetic evidence'}],flags:[],alternative_solution:false});
  return {id:'S1::'+id,studentId:'S1',questionId:id,question,inputComplete:true,state:'done',pages:[{page_id:'P1'}],result:result(initial),modelReview:result(review),modelReviewState:'done',review:null,attempts:[],reviewAttempts:[]};
}
const batch=tasks=>({settings:{reviewProfile:{model:'synthetic'}},pack:{questions:tasks.map(task=>task.question)},tasks,demo:false});
const csvRow=job=>{
  const rows=exportCSV(job).trim().replace(/^\ufeff/,'').split('\r\n').map(line=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match=>match[1].replaceAll('""','"')));
  return Object.fromEntries(rows[0].map((header,index)=>[header,rows[1][index]]));
};

test('per-question merge follows the specified examples, threshold and equal-score behavior',()=>{
  for(const [x,y,total,status] of [[7,9,8,'adjusted'],[9,7,8,'adjusted'],[7,8,8,'adjusted'],[8,7,8,'adjusted'],[7,10,null,'disagreement'],[10,7,null,'disagreement'],[7,7,7,'agreed'],[0,0,0,'agreed'],[0,2,1,'adjusted']]){
    const task=gradedQuestion(x,y),original=structuredClone(task),summary=getModelReviewSummary(task),advice=taskAdvice(batch([task]),task);
    assert.equal(summary.status,status,`${x}/${y}`);assert.equal(summary.initialTotal,x);assert.equal(summary.reviewTotal,y);assert.equal(summary.scoreDifference,Math.abs(x-y));assert.equal(summary.suggestedTotal,total);assert.equal(advice.total,total);
    assert.equal(advice.source,status==='adjusted'?'ai_adjusted':status==='agreed'?'ai_review':'unresolved');if(status==='adjusted')assert.equal(advice.scores,null);
    assert.equal(getTaskFlags({...task,advice}).attention,status==='disagreement');assert.deepEqual(task,original);
  }
});

test('four-decimal score differences use the exact two-point boundary and ceiling',()=>{
  for(const [x,y,total,status] of [[0.1,2.1,2,'adjusted'],[0.1,2.1001,null,'disagreement'],[0.1,2.0999,2,'adjusted'],[7.0001,8.9999,8,'adjusted'],[7.0002,8.9999,9,'adjusted'],[7.5,7.5,7.5,'agreed']]){
    const task=gradedQuestion(x,y),summary=getModelReviewSummary(task);
    assert.equal(summary.status,status,`${x}/${y}`);assert.equal(taskAdvice(batch([task]),task).total,total,`${x}/${y}`);
  }
});

test('rounding never exceeds a fractional question maximum',()=>{
  const task=gradedQuestion(0.4,0.5,{max:0.5}),summary=getModelReviewSummary(task);
  assert.equal(summary.status,'adjusted');assert.equal(summary.suggestedTotal,0.5);assert.equal(summary.cappedAtMax,true);assert.equal(taskAdvice(batch([task]),task).total,0.5);
  assert.equal(getModelReviewSummary(gradedQuestion(7,8)).cappedAtMax,false);
});

test('rounding happens for each question before the paper total is added',()=>{
  const tasks=[gradedQuestion(7,8,{id:'Q1'}),gradedQuestion(8,9,{id:'Q2'})],job=batch(tasks),row=csvRow(job);
  assert.equal(row.Q1,'8');assert.equal(row.Q2,'9');assert.equal(row['建议总分'],'17');
  assert.equal(row['Q1初评分'],'7');assert.equal(row['Q1模型复核分'],'8');assert.equal(row['Q2初评分'],'8');assert.equal(row['Q2模型复核分'],'9');
  assert.match(row['分数来源'],/Q1:ai_adjusted;Q2:ai_adjusted/);
});

test('opposite disagreements in different questions cannot cancel at paper level',()=>{
  const tasks=[gradedQuestion(7,10,{id:'Q1'}),gradedQuestion(10,7,{id:'Q2'})],job=batch(tasks),row=csvRow(job);
  assert.equal(tasks.reduce((sum,t)=>sum+getModelReviewSummary(t).initialTotal,0),17);assert.equal(tasks.reduce((sum,t)=>sum+getModelReviewSummary(t).reviewTotal,0),17);
  assert.equal(row.Q1,'');assert.equal(row.Q2,'');assert.equal(row['建议总分'],'');
  assert.ok(tasks.every(task=>getTaskFlags({...task,advice:taskAdvice(job,task)}).disagreement));
});

test('unknown scores, review states, flags and missing input never use the close-score rule',()=>{
  for(const source of ['result','modelReview'])for(const issue of ['null','needs_review','flag','invalid']){
    const task=gradedQuestion(7,8);
    if(issue==='null'){task[source].criteria[0].awarded=null;task[source].status='needs_review';}
    if(issue==='needs_review')task[source].status='needs_review';
    if(issue==='flag'){task[source].status='needs_review';task[source].flags=[{code:'UNREADABLE',detail:'Synthetic unclear handwriting',evidence_refs:['P1']}];}
    if(issue==='invalid')task[source].criteria[0].awarded=99;
    assert.equal(getModelReviewSummary(task).status,'unresolved',`${source}/${issue}`);assert.equal(taskAdvice(batch([task]),task).total,null);
  }
  for(const modelReviewState of ['pending','running','error','uncertain']){
    const task={...gradedQuestion(7,8),modelReviewState,modelReview:null};assert.equal(taskAdvice(batch([task]),task).total,null);
  }
  const task={...gradedQuestion(7,8),inputComplete:false,state:'input_missing'};assert.equal(taskAdvice(batch([task]),task).total,null);assert.ok(taskAdvice(batch([task]),task).flags.includes('INPUT_BLOCKED'));
});

test('human decisions override merged and unresolved scores without modifying either model result',()=>{
  for(const y of [8,10]){
    const task=gradedQuestion(7,y),original=structuredClone({initial:task.result,review:task.modelReview});task.pages[0].file=new File(['Synthetic answer'],'synthetic.png',{type:'image/png'});task.reviewHistory=[];reviewTask(task,{C1:0},'Synthetic teacher','');
    const advice=taskAdvice(batch([task]),task);assert.equal(advice.total,0);assert.equal(advice.source,'human');assert.equal(getTaskFlags({...task,advice}).attention,false);assert.deepEqual({initial:task.result,review:task.modelReview},original);
  }
});
