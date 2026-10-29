import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {PDFDocument,PDFName,PDFRawStream,decodePDFRawStream,degrees} from 'pdf-lib';
import {inspectStudentPDFs,materializeStudentPDFPage,studentIdFromPDFFilename,studentPDFPath,STUDENT_PDF_LIMITS} from '../lib/grading/student-pdf.mjs';
if(!globalThis.crypto)globalThis.crypto=webcrypto;
const file=(bytes,path)=>{const f=new File([bytes],path.split('/').at(-1),{type:'application/pdf'});Object.defineProperty(f,'webkitRelativePath',{value:path});return f;};
async function source(count=3,modify=()=>{}){
  const pdf=await PDFDocument.create();
  for(let i=0;i<count;i++){const p=pdf.addPage([400+i*10,600+i*10]);p.drawText(i===0?'COVER-PRIVATE-STUDENT':'ANSWER-PAGE-'+i,{x:30,y:100});}
  pdf.setAuthor('PRIVATE-AUTHOR');pdf.setTitle('PRIVATE-TITLE');pdf.setSubject('PRIVATE-SUBJECT');
  await modify(pdf);
  return pdf.save({useObjectStreams:false});
}
async function textContent(descriptor){const blob=await materializeStudentPDFPage(descriptor);const parsed=await PDFDocument.load(await blob.arrayBuffer());return {blob,parsed};}

test('numeric filename parser preserves leading zeros and ignores missing labels',()=>{
 assert.equal(studentIdFromPDFFilename('batch/0012345678.PDF'),'0012345678');
 for(const name of ['扫描文稿.pdf','abc.pdf','12_34.pdf','1'.repeat(33)+'.pdf','123.png'])assert.equal(studentIdFromPDFFilename(name),null);
});
test('each student PDF is mapped strictly by page position with stable anonymous paths',async()=>{
 const original=file(await source(),'batch/0012345678.pdf');const {documents}=await inspectStudentPDFs([original],2);const d=documents[0];
 assert.equal(d.inputError,'');assert.equal(d.pageCount,3);assert.equal(d.filenameStudentId,'0012345678');
 assert.equal(d.cover.sourcePage,1);assert.deepEqual(d.answerPages.map(p=>p.sourcePage),[2,3]);
 assert.ok(d.answerPages.every(p=>p.page_id==='P1'&&p.path.startsWith(d.id+'/')&&!p.path.includes('0012345678')));
 assert.equal(d.file,original);assert.equal(d.answerPages[0].file instanceof Blob,false);
 const first=await textContent(d.answerPages[0]),second=await textContent(d.answerPages[1]);
 assert.equal(first.parsed.getPageCount(),1);assert.equal(second.parsed.getPageCount(),1);
 assert.equal(first.parsed.getPage(0).getWidth(),410);assert.equal(second.parsed.getPage(0).getWidth(),420);
 const streams=first.parsed.context.enumerateIndirectObjects().filter(([,x])=>x instanceof PDFRawStream).map(([,x])=>new TextDecoder().decode(decodePDFRawStream(x).decode())).join('\n');
 assert.ok(streams.includes(Buffer.from('ANSWER-PAGE-1').toString('hex').toUpperCase()));
 assert.ok(!streams.includes(Buffer.from('COVER-PRIVATE-STUDENT').toString('hex').toUpperCase()));
 assert.ok(!streams.includes(Buffer.from('ANSWER-PAGE-2').toString('hex').toUpperCase()));
});
test('page splitting is deterministic and preserves crop and rotation',async()=>{
 const bytes=await source(3,pdf=>{pdf.getPage(1).setRotation(degrees(90));pdf.getPage(1).setCropBox(10,20,300,400);});
 const a=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];
 await new Promise(resolve=>setTimeout(resolve,5));
 const b=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];
 assert.equal(a.id,b.id);assert.equal(a.sha256,b.sha256);assert.deepEqual(a.answerPages.map(p=>p.sha256),b.answerPages.map(p=>p.sha256));
 const p=(await textContent(a.answerPages[0])).parsed.getPage(0);
 assert.equal(p.getRotation().angle,90);assert.deepEqual(p.getCropBox(),{x:10,y:20,width:300,height:400});
});
test('outputs do not copy document identity metadata, scripts or attachments',async()=>{
 const bytes=await source(3,async pdf=>{pdf.addJavaScript('PRIVATE-SCRIPT','console.log("PRIVATE-SCRIPT")');await pdf.attach(new TextEncoder().encode('PRIVATE-ATTACHMENT'),'private.txt');pdf.getPage(1).node.set(PDFName.of('Metadata'),pdf.context.register(pdf.context.stream('PRIVATE-PAGE-METADATA')));});
 const d=(await inspectStudentPDFs([file(bytes,'123.pdf')],2)).documents[0];assert.equal(d.inputError,'');
 const {blob,parsed}=await textContent(d.answerPages[0]);
 assert.equal(parsed.getAuthor(),'');assert.equal(parsed.getTitle(),'');assert.equal(parsed.getSubject(),'');
 assert.equal(parsed.getCreationDate().toISOString(),'2000-01-01T00:00:00.000Z');
 assert.equal(parsed.catalog.get(PDFName.of('Names')),undefined);assert.equal(parsed.catalog.get(PDFName.of('OpenAction')),undefined);
 assert.equal(parsed.getPage(0).node.get(PDFName.of('Metadata')),undefined);
 const all=new TextDecoder('latin1').decode(await parsed.save({useObjectStreams:false}));
 for(const text of ['PRIVATE-AUTHOR','PRIVATE-TITLE','PRIVATE-SCRIPT','PRIVATE-ATTACHMENT','PRIVATE-PAGE-METADATA'])assert.ok(!all.includes(text),text);
 assert.ok(blob.size<STUDENT_PDF_LIMITS.pageBytes);
});
test('annotation cross-page references are rejected, not silently stripped',async()=>{
 const bytes=await source(3,pdf=>{const target=pdf.getPage(0).ref;const annotation=pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[0,0,100,100],Dest:[target,PDFName.of('Fit')]}));pdf.getPage(1).node.set(PDFName.of('Annots'),pdf.context.obj([annotation]));});
 const d=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];assert.match(d.inputError,/批注|交互/);assert.equal(d.cover,null);assert.deepEqual(d.answerPages,[]);
});
test('nonempty interactive forms are rejected without losing their appearance',async()=>{
 const bytes=await source(3,pdf=>{pdf.getForm().createTextField('student-name').setText('PRIVATE-FORM');});
 const d=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];assert.match(d.inputError,/表单/);assert.deepEqual(d.answerPages,[]);
});
test('wrong page count retains a cover but never assigns shifted answers',async()=>{
 const {documents}=await inspectStudentPDFs([file(await source(2),'1.pdf'),file(await source(4),'2.pdf'),file(await source(3),'3.pdf')],2);
 assert.match(documents[0].inputError,/共2页/);assert.match(documents[1].inputError,/共4页/);
 for(const d of documents.slice(0,2)){assert.ok(d.cover);assert.deepEqual(d.answerPages,[]);}
 assert.equal(documents[2].inputError,'');assert.equal(documents[2].answerPages.length,2);
});
test('unsupported, corrupt and unreadable files do not block other students',async()=>{
 const bytes=await source(3);const unreadable={name:'4.pdf',size:10,arrayBuffer:async()=>{throw Error('device unavailable');}};
 const {documents}=await inspectStudentPDFs([new File(['notes'],'notes.txt'),file(new TextEncoder().encode('%PDF-broken'),'2.pdf'),unreadable,file(bytes,'3.pdf')],2);
 assert.equal(documents.length,4);assert.ok(documents.slice(0,3).every(d=>d.inputError&&d.answerPages.length===0));assert.equal(documents[3].inputError,'');
 assert.match(documents[1].sha256,/^[a-f0-9]{64}$/);assert.equal(documents[2].sha256,null);
});
test('too large source is rejected before allocating its data',async()=>{
 let reads=0;const large={name:'1.pdf',size:STUDENT_PDF_LIMITS.documentBytes+1,arrayBuffer:async()=>{reads++;throw Error('must not read');}};
 const d=(await inspectStudentPDFs([large],2)).documents[0];assert.match(d.inputError,/64 MiB/);assert.equal(reads,0);assert.equal(d.sha256,null);
});
test('too many PDF pages are isolated per document',async()=>{
 const bytes=await source(102);const d=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];assert.equal(d.pageCount,102);assert.match(d.inputError,/101/);assert.equal(d.cover,null);
});
test('duplicate paths have distinct blocked records; hidden system files are ignored',async()=>{
 const bytes=await source(3);const {documents}=await inspectStudentPDFs([file(bytes,'batch/1.pdf'),file(bytes,'batch/1.pdf'),file(bytes,'batch/2.pdf'),new File(['x'],'.DS_Store')],2);
 assert.equal(documents.length,3);assert.equal(new Set(documents.map(d=>d.id)).size,3);assert.ok(documents.slice(0,2).every(d=>/重复/.test(d.inputError)));assert.equal(documents[2].inputError,'');
});
test('invalid paths and question counts are rejected without guessed attribution',async()=>{
 assert.throws(()=>studentPDFPath({name:'../1.pdf'}),/路径/);
 for(const count of [0,-1,101,1.2])await assert.rejects(()=>inspectStudentPDFs([],count),/数量/);
 await assert.rejects(()=>inspectStudentPDFs([],2),/没有找到/);
});
test('lazy reads verify original and page hashes before upload or preview',async()=>{
 let current=await source(3);const mutable={name:'1.pdf',size:current.length,arrayBuffer:async()=>current.buffer.slice(current.byteOffset,current.byteOffset+current.byteLength)};
 const d=(await inspectStudentPDFs([mutable],2)).documents[0];assert.equal(d.inputError,'');
 await materializeStudentPDFPage(d.answerPages[0]);
 const broken={...d.answerPages[0],sha256:'0'.repeat(64)};await assert.rejects(()=>materializeStudentPDFPage(broken),/不一致/);
 current=Uint8Array.from(current);current[10]^=1;
 await assert.rejects(()=>materializeStudentPDFPage(d.answerPages[0]),/原PDF已改变/);
});

test('PDFs marked encrypted are refused before creating cover or answer uploads',async()=>{
 const bytes=await source(3,pdf=>{pdf.context.trailerInfo.Encrypt=pdf.context.register(pdf.context.obj({Filter:'Standard'}));});
 const d=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];assert.match(d.inputError,/加密|密码/);assert.equal(d.cover,null);assert.deepEqual(d.answerPages,[]);
});
test('oversized split pages block only that paper while retaining a small cover',async()=>{
 const bytes=await source(3,pdf=>{const large=pdf.context.register(pdf.context.stream(new Uint8Array(STUDENT_PDF_LIMITS.pageBytes+1).fill(65)));pdf.getPage(1).node.set(PDFName.of('Contents'),large);});
 const {documents}=await inspectStudentPDFs([file(bytes,'1.pdf'),file(await source(3),'2.pdf')],2);
 assert.match(documents[0].inputError,/单页超过3 MiB/);assert.ok(documents[0].cover);assert.deepEqual(documents[0].answerPages,[]);assert.equal(documents[1].inputError,'');
});

async function sharedImages({form=false,content='/Answer Do'}={}){
 const pdf=await PDFDocument.create();for(let i=0;i<3;i++)pdf.addPage([100,100]);
 const image=(value)=>pdf.context.register(pdf.context.stream(Uint8Array.of(value),{Type:'XObject',Subtype:'Image',Width:1,Height:1,ColorSpace:'DeviceGray',BitsPerComponent:8}));
 const images={Cover:image(255),Answer:image(128),Other:image(0)};
 const resources=pdf.context.obj({XObject:images});
 if(form){const reference=pdf.context.register(pdf.context.stream(new TextEncoder().encode(content),{Type:'XObject',Subtype:'Form',BBox:[0,0,100,100],Resources:resources}));resources.lookup(PDFName.of('XObject')).set(PDFName.of('Wrapper'),reference);content='/Wrapper Do';}
 for(const [i,page] of pdf.getPages().entries()){
  page.node.set(PDFName.of('Resources'),resources);
  page.node.set(PDFName.of('Contents'),pdf.context.register(pdf.context.stream(new TextEncoder().encode(i===0?'/Cover Do':i===1?content:'/Other Do'))));
 }
 return pdf.save({useObjectStreams:false});
}
function imagesIn(pdf){return pdf.context.enumerateIndirectObjects().filter(([,x])=>x instanceof PDFRawStream&&x.dict.get(PDFName.of('Subtype'))?.decodeText?.()==='Image');}
test('shared whole-document image resources do not carry cover pixels into answers',async()=>{
 const d=(await inspectStudentPDFs([file(await sharedImages(),'1.pdf')],2)).documents[0];assert.equal(d.inputError,'');
 const expected=[255,128,0];let index=0;
 for(const descriptor of [d.cover,...d.answerPages]){
  const {parsed}=await textContent(descriptor);const images=imagesIn(parsed);
  assert.equal(images.length,1);assert.deepEqual([...decodePDFRawStream(images[0][1]).decode()],[expected[index++]]);
 }
});
test('nested form resources are pruned and repeated lazy reads remain deterministic',async()=>{
 const d=(await inspectStudentPDFs([file(await sharedImages({form:true}),'1.pdf')],2)).documents[0];assert.equal(d.inputError,'');
 for(let i=0;i<2;i++){
  const {parsed}=await textContent(d.answerPages[0]);const images=imagesIn(parsed);
  assert.equal(images.length,1);assert.deepEqual([...decodePDFRawStream(images[0][1]).decode()],[128]);
 }
});
test('comments, strings, hex strings and arrays cannot retain unused image resources',async()=>{
 const content='% /Cover Do\n(/Cover Do \\(nested\\)) Tj\n[ /Other (Do) ] TJ\n<2F436F76657220446F> Tj\n/An#73wer Do';
 const d=(await inspectStudentPDFs([file(await sharedImages({content}),'1.pdf')],2)).documents[0];assert.equal(d.inputError,'');
 const images=imagesIn((await textContent(d.answerPages[0])).parsed);assert.equal(images.length,1);assert.deepEqual([...decodePDFRawStream(images[0][1]).decode()],[128]);
});
test('ambiguous inline image syntax is rejected rather than guessing resource boundaries',async()=>{
 const d=(await inspectStudentPDFs([file(await sharedImages({content:'BI /W 1 /H 1 ID binary /Cover Do EI'}),'1.pdf')],2)).documents[0];
 assert.match(d.inputError,/内嵌图像/);assert.deepEqual(d.answerPages,[]);
});

test('complex transparency and pattern resources cannot smuggle extra page graphs',async()=>{
 for(const mode of ['mask','pattern']){
  const bytes=await source(3,pdf=>{
   const page=pdf.getPage(1);
   if(mode==='mask'){
    const g=pdf.context.register(pdf.context.stream(new Uint8Array(),{Type:'XObject',Subtype:'Form',BBox:[0,0,100,100]}));
    page.node.set(PDFName.of('Resources'),pdf.context.obj({ExtGState:{GS:{SMask:{S:'Alpha',G:g}}}}));
    page.node.set(PDFName.of('Contents'),pdf.context.register(pdf.context.stream(new TextEncoder().encode('/GS gs'))));
   }else{
    page.node.set(PDFName.of('Resources'),pdf.context.obj({Pattern:{P1:{PatternType:2}}}));
    page.node.set(PDFName.of('Contents'),pdf.context.register(pdf.context.stream(new TextEncoder().encode('/Pattern cs /P1 scn'))));
   }
  });
  const d=(await inspectStudentPDFs([file(bytes,'1.pdf')],2)).documents[0];assert.match(d.inputError,/蒙版|图案/);assert.deepEqual(d.answerPages,[]);
 }
});
