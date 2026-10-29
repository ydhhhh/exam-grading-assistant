import test from 'node:test';
import assert from 'node:assert/strict';
import {getTaskFlags,getDocumentFlags,filterResults,filterDocuments,countResultFilters,countDocumentFilters,paginate,hasUncertainCost,getInstructionWarnings} from '../lib/grading/result-filters.mjs';
import {getModelReviewSummary} from '../lib/grading/review-comparison.mjs';

const doc=(overrides={})=>({id:'doc-1',path:'synthetic/001.pdf',studentId:'001',filenameStudentId:'001',name:'',mappingStatus:'ready',identityState:'done',attempts:[],...overrides});
const task=(overrides={},document=doc())=>({id:document.id+'::Q1',studentId:document.id,questionId:'Q1',inputComplete:true,state:'ready',attempts:[],result:null,review:null,advice:{total:null,source:'unresolved',flags:['RESULT_PENDING']},display:{studentId:document.studentId,name:document.name,status:document.mappingStatus,document},...overrides});
const completed=(overrides={},document=doc())=>task({state:'done',result:{status:'scored'},advice:{total:0,source:'ai',flags:[]},...overrides},document);

test('queued work, ongoing grading and ongoing identity recognition are not exceptions',()=>{
  for(const state of ['ready','running'])assert.equal(getTaskFlags(task({state,attempts:state==='running'?[{costCny:null,state:'in_flight'}]:[]})).attention,false);
  for(const identityState of ['pending','running']){
    const document=doc({mappingStatus:'pending',identityState,attempts:identityState==='running'?[{state:'in_flight',costCny:null}]:[]});
    assert.equal(getTaskFlags(task({},document)).attention,false);
    assert.equal(getDocumentFlags(document,[task({},document)]).attention,false);
  }
});

test('an unreadable or omitted name does not block a known student identity',()=>{
  const document=doc({name:null,nameSource:'unreadable',identityWarnings:['姓名未能辨认，姓名列留空。']});
  const item=completed({},document);
  assert.equal(getTaskFlags(item).attention,false);
  assert.equal(getTaskFlags(item).complete,true);
  assert.equal(getDocumentFlags(document,[item]).complete,true);
});

test('all explicit identity conflicts and failed identity requests are discoverable',()=>{
  for(const mappingStatus of ['conflict','missing_id','duplicate','roster_mismatch']){
    const document=doc({mappingStatus});
    assert.equal(getTaskFlags(task({},document)).identity,true);
    assert.equal(filterDocuments([document],[task({},document)],{filter:'identity'}).length,1);
  }
  for(const identityState of ['error','uncertain']){
    const document=doc({mappingStatus:'pending',identityState});
    assert.equal(getTaskFlags(task({},document)).identity,true);
  }
});

test('missing pages and unresolved scoring points remain exceptions, never completed zeroes',()=>{
  const input=task({inputComplete:false,state:'input_missing'});
  const points=task({state:'done',result:{status:'needs_review'},advice:{total:null,source:'unresolved',flags:['RESULT_NEEDS_REVIEW']}});
  const badPDF=doc({inputError:'合成PDF页数不符',mappingStatus:'input_error'});
  assert.equal(getTaskFlags(input).inputMissing,true);
  assert.equal(getTaskFlags(input).complete,false);
  assert.equal(getTaskFlags(points).needsReview,true);
  assert.equal(getTaskFlags(points).attention,true);
  assert.equal(getDocumentFlags(badPDF,[task({},badPDF)]).attention,true);
});

test('successful manual review resolves old grading errors, but never erases unknown costs',()=>{
  const resolved=completed({state:'error',error:'旧错误',review:{},advice:{total:3,source:'human',flags:[]},attempts:[{state:'error',costCny:0.01}]});
  assert.equal(getTaskFlags(resolved).failed,false);
  assert.equal(getTaskFlags(resolved).attention,false);
  const unpaid={...resolved,attempts:[{state:'uncertain',costCny:null}]};
  const flags=getTaskFlags(unpaid);
  assert.equal(flags.failed,false);
  assert.equal(flags.uncertain,true);
  assert.equal(flags.attention,true);
  assert.equal(flags.complete,true);
});

test('manual review also clears a previous needs_review classification',()=>{
  const item=completed({result:{status:'needs_review'},review:{},advice:{total:2,source:'human',flags:[]}});
  assert.equal(getTaskFlags(item).needsReview,false);
  assert.equal(getTaskFlags(item).attention,false);
});

test('identity manual correction resolves identity error while its unknown request fee stays visible',()=>{
  const document=doc({identityReview:{studentId:'001',name:null},identityState:'done',attempts:[{state:'uncertain',costCny:null}]});
  const flags=getTaskFlags(completed({},document));
  assert.equal(flags.identity,false);
  assert.equal(flags.uncertain,true);
  assert.equal(getDocumentFlags(document,[completed({},document)]).uncertain,true);
});

test('unknown billing is determined from the whole ledger, including successful responses',()=>{
  assert.equal(hasUncertainCost([{state:'in_flight',costCny:null}]),false);
  for(const state of ['done','response_saved','uncertain','error'])assert.equal(hasUncertainCost([{state,costCny:null}]),true);
  assert.equal(hasUncertainCost([{state:'uncertain',costCny:0.01}]),false);
  const item=completed({attempts:[{state:'uncertain',costCny:null},{state:'done',costCny:0.01}]});
  assert.equal(filterResults([item],{filter:'uncertain'}).length,1);
  assert.equal(filterResults([item],{filter:'complete'}).length,1);
});

test('document filters aggregate grading problems without leaking across student PDFs',()=>{
  const first=doc(),second=doc({id:'doc-2',studentId:'002',path:'synthetic/002.pdf'});
  const summaries=[completed({},first),task({id:'doc-1::Q2',questionId:'Q2',state:'error'},first),completed({},second)];
  assert.deepEqual(filterDocuments([first,second],summaries,{filter:'failed'}).map(d=>d.id),['doc-1']);
  assert.deepEqual(filterDocuments([first,second],summaries,{filter:'complete'}).map(d=>d.id),['doc-2']);
  assert.deepEqual(countDocumentFilters([first,second],summaries),{all:2,attention:1,identity:0,disagreement:0,instruction:0,failed:1,uncertain:0,complete:1});
});

test('search preserves leading zeroes and supports case-insensitive paths, names and filename IDs',()=>{
  const document=doc({name:'合成甲',path:'ClassA/001.pdf',filenameStudentId:'0009'}),item=task({},document);
  for(const query of ['001','  classa  ','合成甲','0009']){
    assert.equal(filterResults([item],{query}).length,1);
    assert.equal(filterDocuments([document],[item],{query}).length,1);
  }
  assert.equal(filterResults([item],{query:'unmatched'}).length,0);
});

test('counts apply the same search and status semantics, including overlapping fee/completion states',()=>{
  const one=completed({attempts:[{state:'done',costCny:null}]}),two=task({state:'error'},doc({id:'doc-2',studentId:'002',filenameStudentId:'002',path:'synthetic/002.pdf'}));
  assert.deepEqual(countResultFilters([one,two],{query:'001'}),{all:1,attention:1,identity:0,disagreement:0,instruction:0,failed:0,uncertain:1,complete:1});
  assert.deepEqual(filterResults([one,two],{query:'001',filter:'failed'}),[]);
});

test('pagination exposes every row after 200 and clamps stale pages after filtering',()=>{
  const items=Array.from({length:257},(_,id)=>({id}));
  const pages=Array.from({length:6},(_,index)=>paginate(items,index+1,50));
  assert.deepEqual(pages.flatMap(page=>page.items),items);
  assert.equal(pages[5].start,251);assert.equal(pages[5].end,257);
  const filtered=paginate(items.slice(0,3),6,50);
  assert.equal(filtered.page,1);assert.equal(filtered.items.length,3);
  assert.deepEqual(paginate([],99),{items:[],page:1,pageCount:1,total:0,start:0,end:0});
  assert.equal(paginate(items,-5).page,1);
  assert.equal(paginate(items,Infinity).page,1);
  assert.equal(paginate(items,1,0).items.length,1);
});

test('presentation helpers do not mutate source tasks, documents, or request records',()=>{
  const document=doc(),item=completed({attempts:[{state:'done',costCny:null}]},document);
  const original=structuredClone({document,item});
  getTaskFlags(item);getDocumentFlags(document,[item]);filterResults([item]);filterDocuments([document],[item]);countResultFilters([item]);countDocumentFilters([document],[item]);paginate([item]);
  assert.deepEqual({document,item},original);
});

const modelResult=(awards,overrides={})=>({question_id:'Q1',status:'scored',criteria:Object.entries(awards).map(([criterion_id,awarded])=>({criterion_id,awarded,evidence_refs:['P1'],reason:'合成评分依据'})),flags:[],alternative_solution:false,...overrides});
const reviewed=(overrides={},document=doc())=>task({state:'done',result:modelResult({C1:1,C2:0}),modelReview:modelResult({C1:0,C2:1}),modelReviewState:'done',reviewAttempts:[{state:'done',costCny:0.02}],advice:{total:null,source:'unresolved',flags:['MODEL_REVIEW_DISAGREEMENT']},...overrides},document);

test('equal totals with different point awards remain visible as model disagreement',()=>{
  const item=reviewed(),summary=getModelReviewSummary(item);
  assert.equal(summary.initialTotal,1);assert.equal(summary.reviewTotal,1);
  assert.equal(summary.status,'disagreement');
  assert.deepEqual(summary.disagreements,[{criterionId:'C1',initial:1,review:0},{criterionId:'C2',initial:0,review:1}]);
  assert.deepEqual(summary.differences,['C1','C2']);
  assert.equal(getTaskFlags(item).disagreement,true);
  assert.equal(getTaskFlags(item).attention,true);
  assert.equal(getTaskFlags(item).complete,false);
  assert.equal(filterResults([item],{filter:'disagreement'}).length,1);
  assert.equal(filterDocuments([item.display.document],[item],{filter:'disagreement'}).length,1);
  assert.equal(countResultFilters([item]).disagreement,1);
  assert.equal(countDocumentFilters([item.display.document],[item]).disagreement,1);
});

test('model agreement is determined by criterion IDs and preserves decimal precision',()=>{
  const item=reviewed({result:modelResult({C1:0.1,C2:0.2}),modelReview:modelResult({C2:0.2,C1:0.1}),advice:{total:0.3,source:'ai_review',flags:[]}});
  const summary=getModelReviewSummary(item);
  assert.equal(summary.status,'agreed');assert.equal(summary.initialTotal,0.3);assert.equal(summary.reviewTotal,0.3);
  assert.deepEqual(summary.disagreements,[]);
  assert.equal(getTaskFlags(item).complete,true);assert.equal(getTaskFlags(item).attention,false);
});

test('queued and running model reviews are not exceptions',()=>{
  for(const modelReviewState of ['pending','running']){
    const item=reviewed({modelReview:null,modelReviewState,reviewAttempts:modelReviewState==='running'?[{state:'in_flight',costCny:null}]:[],advice:{total:null,source:'unresolved',flags:['MODEL_REVIEW_PENDING']}});
    assert.equal(getModelReviewSummary(item).status,modelReviewState);
    assert.equal(getTaskFlags(item).attention,false);assert.equal(getTaskFlags(item).complete,false);
  }
  assert.equal(getModelReviewSummary(completed()).status,'disabled');
});

test('model review failures and unknown costs remain discoverable separately',()=>{
  for(const modelReviewState of ['error','uncertain']){
    const item=reviewed({modelReview:null,modelReviewState,reviewAttempts:[{state:modelReviewState,costCny:0.02}]});
    assert.equal(getTaskFlags(item).failed,true);assert.equal(getTaskFlags(item).uncertain,false);
  }
  const item=reviewed({modelReview:modelResult({C1:1,C2:0}),advice:{total:1,source:'ai_review',flags:[]},reviewAttempts:[{state:'done',costCny:null}]});
  assert.equal(getTaskFlags(item).uncertain,true);assert.equal(getTaskFlags(item).complete,true);
  assert.equal(getTaskFlags(item).failed,false);assert.equal(getTaskFlags(item).attention,true);
});

test('human confirmation resolves disagreement without removing either AI result or unpaid costs',()=>{
  const item=reviewed({review:{scores:{C1:1,C2:1}},advice:{total:2,source:'human',flags:[]},reviewAttempts:[{state:'done',costCny:null}]});
  const before=structuredClone(item),flags=getTaskFlags(item);
  assert.equal(flags.disagreement,false);assert.equal(flags.needsReview,false);assert.equal(flags.failed,false);
  assert.equal(flags.uncertain,true);assert.equal(flags.complete,true);assert.equal(flags.attention,true);
  assert.equal(getModelReviewSummary(item).status,'disagreement');
  assert.deepEqual(item,before);
});

test('unresolved points and missing or malformed review results never masquerade as agreement or zero',()=>{
  const undecided=modelResult({C1:null,C2:0},{status:'needs_review'});
  let item=reviewed({result:undecided,modelReview:structuredClone(undecided),advice:{total:null,source:'unresolved',flags:['MODEL_REVIEW_UNRESOLVED']}});
  assert.equal(getModelReviewSummary(item).status,'unresolved');assert.equal(getModelReviewSummary(item).initialTotal,null);
  assert.equal(getTaskFlags(item).needsReview,true);
  item={...item,modelReview:modelResult({C1:0,C2:0})};
  assert.equal(getModelReviewSummary(item).status,'disagreement');assert.equal(getModelReviewSummary(item).reviewTotal,0);
  for(const modelReview of [null,modelResult({C1:1}),modelResult({C1:NaN,C2:0}),modelResult({C1:1,C2:0},{flags:[{code:'UNREADABLE'}]})]){
    const summary=getModelReviewSummary(reviewed({modelReview}));
    assert.equal(summary.status,'unresolved');
  }
});

test('disagreement filtering is scoped to its own PDF and current search',()=>{
  const first=doc(),second=doc({id:'doc-2',studentId:'002',path:'synthetic/002.pdf'});
  const items=[reviewed({},first),completed({},second)];
  assert.deepEqual(filterDocuments([first,second],items,{filter:'disagreement'}).map(item=>item.id),['doc-1']);
  assert.equal(countResultFilters(items,{query:'002'}).disagreement,0);
  assert.equal(filterResults(items,{filter:'disagreement',query:'002'}).length,0);
});

test('agreement also requires valid allowed scores and evidence for the actual question',()=>{
  const question={question_id:'Q1',text:'合成题',solution:'合成答案',max_score:2,criteria:['C1','C2'].map(criterion_id=>({criterion_id,description:'合成评分点',allowed_scores:[0,1],requires:[]}))};
  const base=reviewed({question,pages:[{page_id:'P1'}],modelReview:modelResult({C1:1,C2:0})});
  assert.equal(getModelReviewSummary(base).status,'agreed');
  const badScore=modelResult({C1:2,C2:0});
  assert.equal(getModelReviewSummary({...base,result:badScore,modelReview:structuredClone(badScore)}).status,'unresolved');
  const otherPage=modelResult({C1:1,C2:0});otherPage.criteria[0].evidence_refs=['OTHER_PAGE'];
  const invalid=getModelReviewSummary({...base,modelReview:otherPage});
  assert.equal(invalid.status,'unresolved');assert.equal(invalid.reviewTotal,null);
});

test('an instruction concern from either model is discoverable without assuming misconduct',()=>{
  const flagged=modelResult({C1:1,C2:0},{status:'needs_review',flags:[{code:'UNTRUSTED_INSTRUCTION',detail:'合成干扰语句，需对照原卷核查',evidence_refs:['P1']}]});
  for(const source of ['result','modelReview']){
    const item=reviewed({[source]:flagged});
    assert.equal(getTaskFlags(item).instruction,true);
    assert.equal(getTaskFlags(item).attention,true);
    assert.equal(filterResults([item],{filter:'instruction'}).length,1);
    assert.equal(filterDocuments([item.display.document],[item],{filter:'instruction'}).length,1);
    assert.equal(countResultFilters([item]).instruction,1);
    assert.deepEqual(getInstructionWarnings(item).map(w=>w.source),[source==='result'?'初评':'模型复核']);
  }
});

test('human resolution clears the instruction queue but preserves original concerns and unknown cost',()=>{
  const item=reviewed({result:modelResult({C1:1,C2:0},{status:'needs_review',flags:[{code:'UNTRUSTED_INSTRUCTION',detail:'合成提示',evidence_refs:['P1']}]}),review:{scores:{C1:1,C2:0}},advice:{total:1,source:'human',flags:[]},reviewAttempts:[{state:'done',costCny:null}]});
  const snapshot=structuredClone(item);
  assert.equal(getTaskFlags(item).instruction,false);
  assert.equal(getTaskFlags(item).uncertain,true);
  assert.equal(getInstructionWarnings(item).length,1);
  assert.deepEqual(item,snapshot);
});

test('ordinary answers mentioning instructions do not create keyword-based suspicion',()=>{
  const item=reviewed({result:modelResult({C1:1,C2:0}),modelReview:modelResult({C1:1,C2:0}),advice:{total:1,source:'ai_review',flags:[]}});
  item.result.criteria[0].reason='题目要求分析“忽略上文”等提示词，学生已按题意作答。';
  assert.equal(getTaskFlags(item).instruction,false);
  assert.equal(getInstructionWarnings(item).length,0);
});
