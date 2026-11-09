/** Opaque origins are unique per sandboxed document; the bridge carries layout only, never effects or secrets. */
export const appFrameClient=String.raw`
function appFrameMessage(event){
 if(event.origin!=='null'||!event.source)return;const frame=[...document.querySelectorAll('iframe.app-isolated-frame')].find(frame=>frame.contentWindow===event.source),data=event.data;
 if(!frame?.isConnected||!data||typeof data!=='object'||Array.isArray(data))return;
 if(data.type==='ready'&&Object.keys(data).length===1)return;
 if(data.type!=='resize'||Object.keys(data).length!==2||!Number.isSafeInteger(data.height)||data.height<80||data.height>1200)return;
 frame.style.height=data.height+'px';
}
window.addEventListener('message',appFrameMessage);
function appFrame(title,url){
 if(typeof url!=='string'||!(/^(?:massion-app:\/\/document|http:\/\/127\.0\.0\.1:[0-9]{1,5})\/[a-f0-9]{64}$/).test(url))throw new Error('Invalid hosted app document');
 const frame=element('iframe');frame.setAttribute('title',title);frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.setAttribute('credentialless','');frame.className='app-isolated-frame';
 frame.style.width='100%';frame.style.height='400px';frame.style.border='0';
 frame.src=url;
 return frame;
}
`;
