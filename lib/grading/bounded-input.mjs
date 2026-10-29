/** Bound untrusted incoming streams by bytes, elapsed time and request lifetime. */
export class BoundedInputError extends Error {
  constructor(code,message,status){super(message);this.name='BoundedInputError';this.code=code;this.status=status;}
}

export async function readBoundedInput(request,{maximum,timeoutMs=30000,label='提交材料'}={}){
  if(!Number.isSafeInteger(maximum)||maximum<1||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new TypeError('Invalid incoming stream limits');
  const invalid=(code,message,status)=>new BoundedInputError(code,`${label}${message}`,status);
  if(request.signal?.aborted)throw invalid('REQUEST_ABORTED','传输已取消，尚未发出模型请求。',408);
  if(!request.body)return '';
  let reader;
  try{reader=request.body.getReader();}catch{throw invalid('INVALID_BODY','无法读取，尚未发出模型请求。',400);}
  let timer,complete=false,stopped=false,rejectStop;
  const interrupted=new Promise((_,reject)=>{rejectStop=reject;});
  // Never wait for an untrusted stream's cancel callback: it too may never settle.
  const cancel=()=>{try{void reader.cancel().catch(()=>{});}catch{}};
  const stop=error=>{if(stopped)return;stopped=true;rejectStop(error);cancel();};
  const aborted=()=>stop(invalid('REQUEST_ABORTED','传输已取消，尚未发出模型请求。',408));
  const read=async()=>{
    const chunks=[];let size=0;
    while(true){
      const {done,value}=await reader.read();
      if(stopped)throw invalid('REQUEST_ABORTED','传输已停止，尚未发出模型请求。',408);
      if(done)break;
      if(!(value instanceof Uint8Array))throw invalid('INVALID_BODY','内容格式无效。',400);
      size+=value.byteLength;
      if(size>maximum)throw invalid('TOO_LARGE','超出程序允许大小。',413);
      chunks.push(value);
    }
    const bytes=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);complete=true;return text;}
    catch{throw invalid('INVALID_ENCODING','编码无效。',400);}
  };
  try{
    request.signal?.addEventListener('abort',aborted,{once:true});
    // Also catches an abort between the first check and listener registration.
    if(request.signal?.aborted)aborted();
    timer=setTimeout(()=>stop(invalid('REQUEST_TIMEOUT','上传超时，尚未发出模型请求。请检查网络后手动继续。',408)),timeoutMs);
    return await Promise.race([interrupted,read()]);
  }finally{
    clearTimeout(timer);request.signal?.removeEventListener('abort',aborted);
    if(!complete)cancel();
    reader.releaseLock();
  }
}
