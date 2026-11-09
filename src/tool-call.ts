/** Host constants, not owner settings. A caller may only tighten its bound. */
export const TOOL_TIMEOUT_MS=180000,APP_TIMEOUT_MS=5000,TOOL_TIMEOUT_VERSION='tool-timeouts/v1';
export class ToolCallError extends Error {
 readonly outcome:'failed'|'unknown';readonly timedOut:boolean;
 constructor(outcome:'failed'|'unknown',timedOut:boolean){super(timedOut?'Tool call timed out':'Tool call interrupted');this.name='ToolCallError';this.outcome=outcome;this.timedOut=timedOut;}
}
/** Unclear calls are writes. Cancel requests cleanup; it never proves an external stop. */
export async function callTool<T>(invoke:(signal:AbortSignal)=>Promise<T>,options:{readOnly?:boolean;signal?:AbortSignal;timeoutMs?:number}={}):Promise<T>{
 const timeoutMs=options.timeoutMs??TOOL_TIMEOUT_MS;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>TOOL_TIMEOUT_MS)throw new Error('Invalid tool deadline');
 if(options.signal?.aborted)throw new ToolCallError('failed',false);
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,started=false,interrupt!:()=>void;
 const interrupted=new Promise<never>((_,reject)=>{
  const stop=(timedOut:boolean)=>{const error=new ToolCallError(started&&!options.readOnly?'unknown':'failed',timedOut);reject(error);controller.abort(error);};
  interrupt=()=>stop(false);timer=setTimeout(()=>stop(true),timeoutMs);options.signal?.addEventListener('abort',interrupt,{once:true});
 });
 try{if(options.signal?.aborted){interrupt();return await interrupted;}started=true;return await Promise.race([interrupted,invoke(controller.signal)]);}
 finally{clearTimeout(timer);options.signal?.removeEventListener('abort',interrupt);}
}
