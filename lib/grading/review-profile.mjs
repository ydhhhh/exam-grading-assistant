/** Public model configuration; credentials are forbidden in this object. */
import {validateStageProfile,estimateProfileCny} from './providers.mjs';
export const validateReviewProfile=validateStageProfile;
const canonical=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?'['+value.map(canonical).join(',')+']':'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
export function profilesEqual(a,b){try{validateReviewProfile(a);validateReviewProfile(b);return canonical(a)===canonical(b);}catch{return false;}}
export async function reviewResultHash(result){return [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(result))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export const estimateReviewCny=estimateProfileCny;
