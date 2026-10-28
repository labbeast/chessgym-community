// Catalog preparation is the only retryable table response. Never retry writes
// or unrelated failures, and let navigation cancel both the request and wait.
const aborted=()=>new DOMException('Aborted','AbortError');

export function waitForRetry(milliseconds,signal){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(aborted());return;}
  const cleanup=()=>signal?.removeEventListener('abort',cancel);
  const timer=setTimeout(()=>{cleanup();resolve();},milliseconds);
  function cancel(){clearTimeout(timer);cleanup();reject(aborted());}
  signal?.addEventListener('abort',cancel,{once:true});
 });
}

export async function requestPreparedCatalog(request,url,{signal,onPreparing=()=>{},wait=waitForRetry,maxRetries=3}={}){
 for(let attempt=0;;attempt++){
  if(signal?.aborted)throw aborted();
  try{return await request(url,{signal});}
  catch(error){
   if(error.status!==503||error.reason!=='catalog-preparing'||attempt>=maxRetries||signal?.aborted)throw error;
   onPreparing();
   if(signal?.aborted)throw aborted();
   await wait(Math.min(2000,Math.max(500,(error.retryAfter||1)*1000)),signal);
  }
 }
}
