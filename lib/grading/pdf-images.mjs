/** Bounded local rasterization. Only the supplied PDF's pixels leave this module. */
export const PDF_IMAGE_SETTINGS=Object.freeze({version:'pdf-image-2000-jpeg94-v1',maxEdge:2000,maxPixels:4_000_000,quality:0.94,maxPages:20,maxImageBytes:3*1024*1024,maxTotalBytes:6*1024*1024,pageTimeoutMs:30000});
let pdfjsPromise;
async function loadPDFJS(){
  pdfjsPromise??=import('pdfjs-dist/legacy/build/pdf.mjs').then(pdfjs=>{
    pdfjs.GlobalWorkerOptions.workerSrc=`/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
    return pdfjs;
  }).catch(error=>{pdfjsPromise=undefined;throw error;});
  return pdfjsPromise;
}
function browserCanvas(width,height){
  if(!globalThis.document)throw Error('PDF转图片需要浏览器画布，请在浏览器中运行。');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const context=canvas.getContext('2d',{alpha:false});if(!context)throw Error('无法创建PDF转图片画布。');
  return {canvas,context,encode:()=>new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(Error('PDF图片编码失败。')),'image/jpeg',PDF_IMAGE_SETTINGS.quality)),dispose:()=>{canvas.width=0;canvas.height=0;}};
}
export async function renderPDFToImages(bytes,{maxPages=PDF_IMAGE_SETTINGS.maxPages,pdfjs,createCanvas=browserCanvas,assetBaseURL,stageTimeoutMs=PDF_IMAGE_SETTINGS.pageTimeoutMs}={}){
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>64*1024*1024)throw Error('待转换PDF为空或超过64 MiB。');
  if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>PDF_IMAGE_SETTINGS.maxPages)throw Error('PDF转换页数上限无效。');
  if(!Number.isSafeInteger(stageTimeoutMs)||stageTimeoutMs<1||stageTimeoutMs>PDF_IMAGE_SETTINGS.pageTimeoutMs)throw Error('PDF转换超时设置无效。');
  const bounded=async(operation,label,cancel=()=>{},timeout=stageTimeoutMs)=>{
    let timer;
    try{return await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{try{Promise.resolve(cancel()).catch(()=>{});}catch{}reject(Error(`PDF${label}超时，请重新导出扫描件。`));},timeout);})]);}
    finally{clearTimeout(timer);}
  };
  const engine=pdfjs||await bounded(loadPDFJS(),'组件加载');
  const assets=assetBaseURL||`/pdfjs/${engine.version}/`;
  const loading=engine.getDocument({data:bytes.slice(),isEvalSupported:false,enableXfa:false,useSystemFonts:false,cMapUrl:assets+'cmaps/',cMapPacked:true,iccUrl:assets+'iccs/',standardFontDataUrl:assets+'standard_fonts/',wasmUrl:assets+'wasm/',canvasMaxAreaInBytes:32*1024*1024,stopAtErrors:true});
  let doc,total=0;const images=[];
  try{
    doc=await bounded(loading.promise,'读取',()=>loading.destroy());
    if(doc.numPages<1||doc.numPages>maxPages)throw Error(maxPages===1?'作答转换只接受已拆好的单页PDF。':`教学材料PDF最多${maxPages}页，请拆分整理后再上传。`);
    for(let n=1;n<=doc.numPages;n++){
      const page=await bounded(doc.getPage(n),'页面读取',()=>loading.destroy());let surface;
      try{
        const original=page.getViewport({scale:1});
        if(!Number.isFinite(original.width)||!Number.isFinite(original.height)||original.width<=0||original.height<=0)throw Error('PDF页面尺寸无效。');
        const scale=PDF_IMAGE_SETTINGS.maxEdge/Math.max(original.width,original.height);
        const viewport=page.getViewport({scale});const width=Math.ceil(viewport.width),height=Math.ceil(viewport.height);
        if(width*height>PDF_IMAGE_SETTINGS.maxPixels)throw Error('PDF页面图片超过像素限制。');
        surface=createCanvas(width,height);
        const rendering=page.render({canvas:surface.canvas,canvasContext:surface.context,viewport,background:'rgb(255,255,255)'});
        await bounded(rendering.promise,'单页转换',()=>rendering.cancel());
        const blob=await bounded(surface.encode(),'图片编码');
        if(!(blob instanceof Blob)||blob.type!=='image/jpeg'||!blob.size||blob.size>PDF_IMAGE_SETTINGS.maxImageBytes)throw Error('PDF转换图片为空、格式无效或超过3 MiB，请重新导出清晰且较小的扫描件。');
        total+=blob.size;if(total>PDF_IMAGE_SETTINGS.maxTotalBytes)throw Error('PDF转换图片合计超过6 MiB，请精简教学材料后再上传。');
        images.push(new File([blob],`page-${n}.jpg`,{type:'image/jpeg',lastModified:0}));
      }finally{surface?.dispose();page.cleanup();}
    }
    return images;
  }catch(error){
    if(error?.name==='PasswordException')throw Error('PDF已加密，请先解锁后再转换。');
    throw new Error('PDF转图片失败：'+(error?.message||'无法读取页面。'));
  }finally{
    // Cleanup must not turn a bounded failure back into an indefinitely stuck job.
    try{await bounded(Promise.resolve(loading.destroy()),'资源释放',()=>{},Math.min(stageTimeoutMs,1000));}catch{}
  }
}
