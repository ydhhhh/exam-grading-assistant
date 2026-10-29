import test from 'node:test';
import assert from 'node:assert/strict';
import {validateIdentityResult} from '../lib/grading/identity-validation.mjs';
const identity=()=>({name:'演示姓名',student_id:'001234',name_status:'readable',student_id_status:'readable',warnings:[]});

test('identity preserves a clear name and leading-zero student ID',()=>{
  const result=identity();assert.equal(validateIdentityResult(result),result);assert.equal(result.student_id,'001234');
  result.name='Amina · Lee';validateIdentityResult(result);
});
test('each unreadable or blank identity field stays null independently',()=>{
  for(const field of ['name','student_id'])for(const status of ['unreadable','blank']){
    const result=identity();result[field]=null;result[field+'_status']=status;validateIdentityResult(result);
    assert.equal(result[field==='name'?'student_id':'name'],field==='name'?'001234':'演示姓名');
  }
});
test('identity status and value must agree without guessed candidates',()=>{
  for(const field of ['name','student_id'])for(const change of [r=>r[field]=null,r=>r[field]='',r=>r[field+'_status']='unreadable',r=>r[field+'_status']='probable']){
    const result=identity();change(result);assert.throws(()=>validateIdentityResult(result));
  }
});
test('identity IDs remain bounded digit strings and names cannot hide control text',()=>{
  for(const value of [1234,'12A4','01 23','1'.repeat(33),' 001234']){const result=identity();result.student_id=value;assert.throws(()=>validateIdentityResult(result));}
  for(const value of ['演示\n姓名',' 姓名','姓名\u007f','名'.repeat(121)]){const result=identity();result.name=value;assert.throws(()=>validateIdentityResult(result));}
});
test('identity rejects extra fields and malformed warning arrays',()=>{
  for(const change of [r=>r.score=100,r=>delete r.name,r=>r.warnings=null,r=>r.warnings=[''],r=>r.warnings=['w'.repeat(1001)],r=>r.warnings=Array(21).fill('warning')]){
    const result=identity();change(result);assert.throws(()=>validateIdentityResult(result));
  }
});
