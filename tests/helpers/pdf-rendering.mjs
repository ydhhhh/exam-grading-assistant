import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';
import {renderPDFToImages} from '../../lib/grading/pdf-images.mjs';
const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');
pdfjs.GlobalWorkerOptions.workerSrc=new URL('../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',import.meta.url).href;
const assetBaseURL=fileURLToPath(new URL('../../node_modules/pdfjs-dist/',import.meta.url));
export const nodeCanvas=(width,height)=>{
  const canvas=createCanvas(width,height);
  return {canvas,context:canvas.getContext('2d'),encode:async()=>new Blob([await canvas.encode('jpeg',94)],{type:'image/jpeg'}),dispose:()=>{canvas.width=0;canvas.height=0;}};
};
export const renderPDF=(bytes,options={})=>renderPDFToImages(bytes,{...options,pdfjs,createCanvas:nodeCanvas,assetBaseURL});
export async function syntheticPDF(count=3,modify=()=>{}){
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  const colors=[rgb(1,0,0),rgb(0,1,0),rgb(0,0,1)];
  for(let i=0;i<count;i++){
    const page=pdf.addPage([400,600]);page.drawRectangle({x:0,y:0,width:400,height:600,color:colors[i%3]});
    page.drawText(i===0?'SYNTHETIC COVER ONLY':`SYNTHETIC ANSWER Q${i}`,{x:20,y:500,size:17,font,color:rgb(1,1,1)});
  }
  await modify(pdf);return pdf.save();
}
export async function imageInfo(file){
  const image=await loadImage(Buffer.from(await file.arrayBuffer())),canvas=createCanvas(image.width,image.height),context=canvas.getContext('2d');
  context.drawImage(image,0,0);const center=[...context.getImageData(Math.floor(image.width/2),Math.floor(image.height/2),1,1).data];
  const result={width:image.width,height:image.height,center};canvas.width=0;canvas.height=0;return result;
}
export function fixturePack(count=1){return {exam_id:'SYNTHETIC',title:'Synthetic only',version:'1',demo:false,approved_by:'Synthetic teacher',policies:'Synthetic fixture; never student data.',questions:Array.from({length:count},(_,i)=>({question_id:'Q'+(i+1),text:'Synthetic question',solution:'Synthetic answer',max_score:5,criteria:[{criterion_id:'C1',description:'Synthetic criterion',allowed_scores:[0,1,2,3,4,5],requires:[]}]}))};}
export const fixtureResult=(questionId='Q1')=>({question_id:questionId,status:'scored',criteria:[{criterion_id:'C1',awarded:5,evidence_refs:['P1'],reason:'Synthetic page evidence'}],flags:[],alternative_solution:false});
export const fixtureIdentity=()=>({name:'合成测试甲',student_id:'900000001',name_status:'readable',student_id_status:'readable',warnings:[]});
export const envelope=(result,usage={input_tokens:1000,output_tokens:200,input_tokens_details:{cached_tokens:500}})=>({id:'response-synthetic',model:'deepseek-flash',status:'completed',usage,output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
