/** Opaque origins are unique per sandboxed document; the bridge carries layout only, never effects or secrets. */
export const appFrameClient=String.raw`
const appFrames=new WeakMap();
function appFrameMessage(event){
 if(event.origin!=='null'||!event.source)return;const frame=appFrames.get(event.source),data=event.data;
 if(!frame?.isConnected||!data||typeof data!=='object'||Array.isArray(data))return;
 if(data.type==='ready'&&Object.keys(data).length===1)return;
 if(data.type!=='resize'||Object.keys(data).length!==2||!Number.isSafeInteger(data.height)||data.height<80||data.height>1200)return;
 frame.style.height=data.height+'px';
}
window.addEventListener('message',appFrameMessage);
function appFrame(title,html){
 const frame=element('iframe');frame.setAttribute('title',title);frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('credentialless','');frame.className='app-isolated-frame';
 frame.style.width='100%';frame.style.height='400px';frame.style.border='0';
 frame.srcdoc='<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src &#39;unsafe-inline&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; connect-src &#39;none&#39;; frame-src &#39;none&#39;; object-src &#39;none&#39;; base-uri &#39;none&#39;; form-action &#39;none&#39;"></head><body>'+html+'</body></html>';
 frame.addEventListener('load',()=>{if(frame.contentWindow)appFrames.set(frame.contentWindow,frame);});return frame;
}
`;
