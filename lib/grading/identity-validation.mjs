/** Data-only identity transcription validation, shared by browser and API. */
import {ValidationError,exactKeys} from './validation.mjs';
const fail=message=>{throw new ValidationError(message);};
const statuses=['readable','unreadable','blank'];
export const IDENTITY_SCHEMA={type:'object',additionalProperties:false,required:['name','student_id','name_status','student_id_status','warnings'],properties:{
  name:{type:['string','null']},student_id:{type:['string','null']},
  name_status:{type:'string',enum:statuses},student_id_status:{type:'string',enum:statuses},
  warnings:{type:'array',items:{type:'string'}}
}};
export function validateIdentityResult(identity){
  exactKeys(identity,['name','student_id','name_status','student_id_status','warnings'],'首页身份识别结果');
  for(const field of ['name','student_id']){
    const status=identity[field+'_status'],value=identity[field];
    if(!statuses.includes(status))fail('首页识别状态无效。');
    if(status!=='readable'){if(value!==null)fail('无法辨认或空白的身份字段必须留空。');continue;}
    if(typeof value!=='string'||!value.trim()||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value))fail('可辨认的身份字段不能为空或包含控制字符。');
    if(field==='student_id'&&!/^[0-9]{1,32}$/.test(value))fail('识别学号须为1至32位数字字符串，保留前导零。');
    if(field==='name'&&value.length>120)fail('识别姓名过长。');
  }
  if(!Array.isArray(identity.warnings)||identity.warnings.length>20||identity.warnings.some(w=>typeof w!=='string'||!w.trim()||w.length>1000))fail('首页识别提示无效。');
  return identity;
}
