/** Local PDF intake. Source files and lazy page handles never belong in backups. */
import {PDFDocument, PDFName, PDFArray, PDFDict, PDFRawStream, decodePDFRawStream} from 'pdf-lib';

export const STUDENT_PDF_LIMITS=Object.freeze({documentBytes:64*1024*1024,pageBytes:3*1024*1024,pages:101,documents:1000});
const FIXED_DATE=new Date('2000-01-01T00:00:00.000Z');
const PDF_MIME='application/pdf';
const fail=message=>{throw new Error(message);};
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
let lastMaterializedSource=null;

export function studentPDFPath(file){
  const value=String(file?.webkitRelativePath||file?.name||'').replaceAll('\\','/');
  if(!value||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..')||/[\u0000-\u001f]/.test(value))fail('PDF文件路径无效，请重新选择答题卡文件夹。');
  return value;
}
const isHidden=path=>path.split('/').some(p=>p.startsWith('.')||p==='__MACOSX');
export function studentIdFromPDFFilename(path){
  const name=String(path).split('/').at(-1)||'';
  const match=/^(\d{1,32})\.pdf$/i.exec(name);
  return match?match[1]:null;
}
function validateQuestionCount(count){
  if(!Number.isInteger(count)||count<1||count>100)fail('题目数量须为1至100的整数。');
}
function signature(bytes){
  if(new TextDecoder('latin1').decode(bytes.subarray(0,5))!=='%PDF-')fail('文件内容不是有效的PDF。');
}
function hasEntries(context,value){
  if(value===undefined)return false;
  const resolved=context.lookup(value);
  return !(resolved instanceof PDFArray&&resolved.size()===0);
}
function ensureScannedPages(doc){
  const form=doc.context.lookup(doc.catalog.get(PDFName.of('AcroForm')));
  if(form!==undefined){
    if(!(form instanceof PDFDict))fail('PDF表单结构无效，请重新扫描或导出普通PDF。');
    if(hasEntries(doc.context,form.get(PDFName.of('Fields'))))fail('PDF包含交互表单，请先导出保留作答外观的普通扫描PDF。');
  }
  for(const page of doc.getPages()){
    if(hasEntries(doc.context,page.node.get(PDFName.of('Annots')))||page.node.has(PDFName.of('AA'))){
      fail('PDF包含批注、链接或交互内容，请先导出保留作答外观的普通扫描PDF；程序不会直接删掉批注。');
    }
  }
}
async function loadPDF(bytes){
  signature(bytes);
  let doc;
  try{doc=await PDFDocument.load(bytes,{ignoreEncryption:false,updateMetadata:false,throwOnInvalidObject:true});}
  catch(e){
    if(e?.name==='EncryptedPDFError'||/encrypted/i.test(String(e?.message)))fail('PDF已加密或需要密码，请先解锁后再选择。');
    fail('PDF损坏或无法解析，请重新扫描或导出。');
  }
  if(doc.isEncrypted)fail('PDF已加密或需要密码，请先解锁后再选择。');
  return doc;
}
function clearPrivatePageEntries(page){
  // Keep only rendering geometry/resources/content. copyPages drops Parent,
  // preventing the original page tree from accompanying the selected page.
  const visualKeys=new Set(['Type','Parent','Resources','Contents','MediaBox','CropBox','BleedBox','TrimBox','ArtBox','Rotate','UserUnit']);
  for(const key of page.node.keys())if(!visualKeys.has(key.decodeText()))page.node.delete(key);
}
function clearResourceMetadata(context){
  // Metadata and associated files may also sit on image/form resources. Remove
  // references before copying so sensitive orphan objects are not serialized.
  const visit=(value,seen)=>{
    const object=context.lookup(value);
    if(!object||seen.has(object))return;seen.add(object);
    if(object instanceof PDFDict){
      for(const key of ['Metadata','PieceInfo','AF','AA','OpenAction'])object.delete(PDFName.of(key));
      for(const [,v] of object.entries())visit(v,seen);
    }else if(object instanceof PDFArray){for(const v of object.asArray())visit(v,seen);}
    else if(object.dict instanceof PDFDict)visit(object.dict,seen);
  };
  const seen=new Set();
  for(const [,object] of context.enumerateIndirectObjects())visit(object,seen);
}

function decodedContents(context,contents){
  if(contents===undefined)return '';
  const value=context.lookup(contents);
  if(value instanceof PDFArray)return value.asArray().map(v=>decodedContents(context,v)).join('\n');
  if(value instanceof PDFRawStream)return new TextDecoder('latin1').decode(decodePDFRawStream(value).decode());
  if(typeof value?.getUnencodedContents==='function')return new TextDecoder('latin1').decode(value.getUnencodedContents());
  fail('PDF页面内容流无效，请重新导出扫描PDF。');
}
function usedResources(contents){
  // Tokenize PDF syntax: names inside strings, comments or compound operands
  // are not executable operators. Inline images are refused instead of trying
  // to locate a possibly ambiguous EI byte sequence in their binary payload.
  const refs=Object.fromEntries(['XObject','Font','ExtGState','ColorSpace','Shading','Pattern','Properties'].map(k=>[k,new Set()]));
  let i=0;const delimiters=/[\s\x00()<>\[\]{}\/%]/;
  const skipSpace=()=>{while(i<contents.length){if(/[\s\x00]/.test(contents[i]))i++;else if(contents[i]==='%'){while(i<contents.length&&!/[\r\n]/.test(contents[i]))i++;}else break;}};
  function token(){
    skipSpace();if(i>=contents.length)return null;const c=contents[i++];
    if(c==='('){let depth=1;while(i<contents.length&&depth){const x=contents[i++];if(x==='\\')i++;else if(x==='(')depth++;else if(x===')')depth--;}if(depth)fail('PDF文本内容未闭合。');return {kind:'literal'};}
    if(c==='<'){
      if(contents[i]==='<'){i++;while(true){skipSpace();if(contents.slice(i,i+2)==='>>'){i+=2;break;}if(!token())fail('PDF字典内容未闭合。');}return {kind:'compound'};}
      while(i<contents.length&&contents[i]!=='>')i++;if(i===contents.length)fail('PDF十六进制文本未闭合。');i++;return {kind:'literal'};
    }
    if(c==='['){while(true){skipSpace();if(contents[i]===']'){i++;break;}if(!token())fail('PDF数组内容未闭合。');}return {kind:'compound'};}
    let value=c;if(c==='/'){value='';while(i<contents.length&&!delimiters.test(contents[i]))value+=contents[i++];return {kind:'name',value:value.replace(/#([0-9a-f]{2})/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))};}
    while(i<contents.length&&!delimiters.test(contents[i]))value+=contents[i++];
    return {kind:/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)||['true','false','null'].includes(value)?'literal':'operator',value};
  }
  let operands=[];
  for(let t; (t=token());){
    if(t.kind!=='operator'){operands.push(t);continue;}
    if(t.value==='BI')fail('PDF采用内嵌图像内容流，请重新导出常规扫描PDF后再选择。');
    const previous=operands.at(-1),first=operands.at(-2);
    const category={Do:'XObject',gs:'ExtGState',CS:'ColorSpace',cs:'ColorSpace',sh:'Shading',SCN:'Pattern',scn:'Pattern',BDC:'Properties',DP:'Properties'}[t.value];
    if(t.value==='Tf'){if(first?.kind!=='name')fail('PDF字体资源引用无效。');refs.Font.add(first.value);}
    else if(category&&previous?.kind==='name')refs[category].add(previous.value);
    else if(['Do','gs','CS','cs','sh'].includes(t.value))fail('PDF图像或图形资源引用无效。');
    operands=[];
  }
  return refs;
}
function trimmedResources(context,sourceResources,contents,ancestors=new Set()){
  const resources=context.lookup(sourceResources);
  const uses=usedResources(contents),out=context.obj({});
  if(resources!==undefined&&!(resources instanceof PDFDict))fail('PDF资源字典无效。');
  for(const [category,names] of Object.entries(uses)){
    if(category==='ColorSpace')for(const standard of ['DeviceRGB','DeviceGray','DeviceCMYK','Pattern'])names.delete(standard);
    const original=context.lookup(resources?.get(PDFName.of(category)));
    if(original!==undefined&&!(original instanceof PDFDict))fail('PDF资源类型无效。');
    // Device color defaults can be used without explicit CS/cs operators.
    if(category==='ColorSpace'&&original)for(const name of ['DefaultRGB','DefaultGray','DefaultCMYK'])if(original.has(PDFName.of(name)))names.add(name);
    if(!names.size)continue;
    const selected=context.obj({});
    for(const name of names){
      const ref=original?.get(PDFName.of(name));if(ref===undefined)fail('PDF引用了不存在的页面资源。');
      let object=context.lookup(ref),selectedRef=ref;
      if(category==='Pattern')fail('PDF使用图案资源，请重新导出普通扫描PDF后再选择。');
      if(category==='ExtGState'&&object instanceof PDFDict){
        const mask=context.lookup(object.get(PDFName.of('SMask')));
        if(mask!==undefined&&!(mask instanceof PDFName&&mask.decodeText()==='None'))fail('PDF使用复杂透明蒙版，请重新导出普通扫描PDF后再选择。');
        if(object.has(PDFName.of('Font')))fail('PDF通过图形状态设置字体，请重新导出普通扫描PDF后再选择。');
      }
      if(category==='XObject'){
        if(!(object instanceof PDFRawStream))fail('PDF图像资源结构无效。');
        const subtype=object.dict.get(PDFName.of('Subtype'))?.decodeText?.();
        if(subtype==='Form'){
          if(ancestors.has(object))fail('PDF图形资源包含循环引用。');
          const next=new Set(ancestors);next.add(object);const form=object.clone(context);
          const own=form.dict.get(PDFName.of('Resources'))??resources;
          form.dict.set(PDFName.of('Resources'),trimmedResources(context,own,decodedContents(context,object),next));
          selectedRef=context.register(form);
        }else if(subtype!=='Image')fail('PDF含不支持的页面图像资源。');
      }
      if(category==='Font'&&object instanceof PDFDict&&object.get(PDFName.of('Subtype'))?.decodeText?.()==='Type3')fail('PDF含自定义图形字体，请重新导出普通扫描PDF。');
      selected.set(PDFName.of(name),selectedRef);
    }
    out.set(PDFName.of(category),selected);
  }
  return out;
}
async function onePageBytes(source,index){
  if(!Number.isInteger(index)||index<0||index>=source.getPageCount())fail('PDF页码无效。');
  const page=source.getPage(index);
  const contents=decodedContents(source.context,page.node.get(PDFName.of('Contents')));
  const resources=trimmedResources(source.context,page.node.Resources(),contents);
  clearPrivatePageEntries(page);page.node.set(PDFName.of('Resources'),resources);
  const target=await PDFDocument.create({updateMetadata:false});
  const [copied]=await target.copyPages(source,[index]);target.addPage(copied);
  target.setTitle('');target.setAuthor('');target.setSubject('');target.setKeywords([]);
  target.setCreator('Grading assistant');target.setProducer('Grading assistant');
  target.setCreationDate(FIXED_DATE);target.setModificationDate(FIXED_DATE);
  const bytes=await target.save({useObjectStreams:true,addDefaultPage:false,updateFieldAppearances:false});
  if(bytes.length>STUDENT_PDF_LIMITS.pageBytes)fail('拆分后的单页超过3 MiB，请降低扫描文件体积后重新选择；不要缩减或裁掉有效作答。');
  return bytes;
}
async function sourceForPage(file,expectedHash){
  const bytes=new Uint8Array(await file.arrayBuffer());
  if(bytes.length!==file.size||await hash(bytes)!==expectedHash)fail('原PDF已改变，请重新选择与进度记录一致的答卷。');
  if(lastMaterializedSource?.file===file&&lastMaterializedSource.sha256===expectedHash)return lastMaterializedSource.doc;
  const doc=await loadPDF(bytes);ensureScannedPages(doc);clearResourceMetadata(doc.context);
  // Cache at most one parsed source, never the full class or generated pages.
  lastMaterializedSource={file,sha256:expectedHash,doc};return doc;
}
function lazyPageFile(sourceFile,sourceHash,index,expectedHash,size){
  return Object.freeze({name:`page-${index+1}.pdf`,type:PDF_MIME,size,
    async arrayBuffer(){
      const source=await sourceForPage(sourceFile,sourceHash);
      const bytes=await onePageBytes(source,index);
      if(bytes.length!==size||await hash(bytes)!==expectedHash)fail('拆分页与原登记不一致，已停止读取。');
      return bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    }
  });
}
async function pageDescriptor(source,index,record){
  const bytes=await onePageBytes(source,index),sha256=await hash(bytes),size=bytes.length;
  return {sourcePage:index+1,page_id:'P1',path:record.id+`/page-${String(index+1).padStart(3,'0')}.pdf`,sha256,mime:PDF_MIME,size,file:lazyPageFile(record.file,record.sha256,index,sha256,size)};
}
export async function materializeStudentPDFPage(page){
  if(!page?.file||typeof page.file.arrayBuffer!=='function')fail('原PDF尚未重新关联，请先重新选择答题卡文件夹。');
  const bytes=await page.file.arrayBuffer();
  if(bytes.byteLength!==page.size||await hash(bytes)!==page.sha256)fail('拆分页内容与进度记录不一致。');
  return new File([bytes],`page-${page.sourcePage||1}.pdf`,{type:PDF_MIME,lastModified:FIXED_DATE.getTime()});
}

export async function inspectStudentPDFs(files,questionCount){
  validateQuestionCount(questionCount);lastMaterializedSource=null;
  const input=Array.from(files||[]);if(input.length>STUDENT_PDF_LIMITS.documents*2)fail('文件过多，请每批最多选择1000份PDF。');
  const entries=input.map(file=>({file,path:studentPDFPath(file)})).filter(x=>!isHidden(x.path));
  if(!entries.length)fail('没有找到可处理的学生PDF。');
  if(entries.length>STUDENT_PDF_LIMITS.documents)fail('每批最多选择1000份PDF。');
  const counts=new Map();for(const x of entries)counts.set(x.path,(counts.get(x.path)||0)+1);
  const occurrences=new Map(),documents=[],warnings=[];
  for(const entry of entries){
    const {file,path}=entry,index=(occurrences.get(path)||0)+1;occurrences.set(path,index);
    const base='pdf-'+(await hash(new TextEncoder().encode(path))).slice(0,24);
    const record={id:base+(counts.get(path)>1?'-duplicate-'+index:''),path,sha256:null,size:Number.isFinite(file?.size)&&file.size>=0?file.size:0,pageCount:null,expectedPageCount:questionCount+1,filenameStudentId:studentIdFromPDFFilename(path),inputError:'',cover:null,answerPages:[],file};
    try{
      if(counts.get(path)>1)fail('同一路径被重复选择，请移除重复文件后重新建批次。');
      if(!/\.pdf$/i.test(path))fail('这里只接受每位同学一份的PDF，请移除非PDF文件。');
      if(!record.size||typeof file?.arrayBuffer!=='function')fail('PDF为空或无法读取。');
      if(record.size>STUDENT_PDF_LIMITS.documentBytes)fail('整份PDF超过64 MiB，请适当压缩扫描文件后再选择。');
      let bytes;try{bytes=new Uint8Array(await file.arrayBuffer());}catch{fail('无法读取PDF，请重新选择文件。');}
      if(bytes.length!==record.size)fail('PDF读取长度不一致，请重新选择文件。');
      record.sha256=await hash(bytes);
      const source=await loadPDF(bytes);record.pageCount=source.getPageCount();
      if(record.pageCount<1||record.pageCount>STUDENT_PDF_LIMITS.pages)fail('PDF页数不在1至101页范围内。');
      ensureScannedPages(source);clearResourceMetadata(source.context);
      record.cover=await pageDescriptor(source,0,record);
      if(record.pageCount!==record.expectedPageCount)fail(`PDF共${record.pageCount}页，应为${record.expectedPageCount}页（1页身份信息+${questionCount}页作答）；本份暂不批改，请补齐或核对页序。`);
      const pages=[];for(let i=1;i<record.pageCount;i++)pages.push(await pageDescriptor(source,i,record));
      record.answerPages=pages;
    }catch(e){record.inputError=e?.message||'PDF检查失败，请重新选择。';record.answerPages=[];}
    documents.push(record);
    if(record.inputError)warnings.push(path+'：'+record.inputError);
    else if(!record.filenameStudentId)warnings.push(path+'：文件名不是学号，将尝试从首页识别学号。');
  }
  return {documents,warnings};
}
