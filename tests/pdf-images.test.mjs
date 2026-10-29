import test from 'node:test';
import assert from 'node:assert/strict';
import {degrees} from 'pdf-lib';
import {readFile} from 'node:fs/promises';
import {renderPDFToImages,PDF_IMAGE_SETTINGS} from '../lib/grading/pdf-images.mjs';
import {inspectStudentPDFs} from '../lib/grading/student-pdf.mjs';
import {renderPDF,syntheticPDF,imageInfo} from './helpers/pdf-rendering.mjs';

test('real PDF rendering keeps every teaching page in order within pixel and byte caps',async()=>{
  const images=await renderPDF(await syntheticPDF());assert.equal(images.length,3);
  for(const [i,file] of images.entries()){
    assert.equal(file.type,'image/jpeg');assert.ok(file.size<=PDF_IMAGE_SETTINGS.maxImageBytes);
    const {width,height,center}=await imageInfo(file);assert.equal(height,2000);assert.ok(width*height<=PDF_IMAGE_SETTINGS.maxPixels);
    for(let channel=0;channel<3;channel++)assert.ok(Math.abs(center[channel]-(channel===i?255:0))<5);
  }
});
test('only the selected answer is rendered; cover and other answers do not enter its image',async()=>{
  const file=new File([await syntheticPDF()],'900000001.pdf',{type:'application/pdf'});
  const record=(await inspectStudentPDFs([file],2)).documents[0];
  const images=await renderPDF(new Uint8Array(await record.answerPages[0].file.arrayBuffer()),{maxPages:1});
  assert.equal(images.length,1);const {center}=await imageInfo(images[0]);assert.ok(center[1]>250&&center[0]<5&&center[2]<5);
});
test('real rasterization honors crop box and page rotation',async()=>{
  const images=await renderPDF(await syntheticPDF(1,pdf=>{const page=pdf.getPage(0);page.setCropBox(0,0,100,200);page.setRotation(degrees(90));}));
  const info=await imageInfo(images[0]);assert.equal(info.width,2000);assert.equal(info.height,1000);
});
test('corrupt PDFs and excessive page counts fail rather than silently omitting pages',async()=>{
  await assert.rejects(()=>renderPDF(new TextEncoder().encode('%PDF-1.7 broken')),/PDF转图片失败/);
  const bytes=await syntheticPDF(2);await assert.rejects(()=>renderPDF(bytes,{maxPages:1}),/单页PDF/);
});
test('oversized or empty conversion inputs are rejected before starting the engine',async()=>{
  for(const bytes of [new Uint8Array(),new Uint8Array(64*1024*1024+1)])await assert.rejects(()=>renderPDFToImages(bytes),/为空或超过/);
  await assert.rejects(()=>renderPDFToImages(new Uint8Array([1]),{maxPages:21}),/页数上限/);
});
test('renderer assets and worker are local and include the upstream license',async()=>{
  const {version}=JSON.parse(await readFile(new URL('../node_modules/pdfjs-dist/package.json',import.meta.url)));
  for(const asset of ['pdf.worker.min.mjs','standard_fonts/LiberationSans-Regular.ttf','cmaps/UniGB-UCS2-H.bcmap','wasm/openjpeg.wasm','iccs/CGATS001Compat-v2-micro.icc','LICENSE']){
    const data=await readFile(new URL(`../public/pdfjs/${version}/${asset}`,import.meta.url));assert.ok(data.length>0,asset);
  }
});
