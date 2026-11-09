let desktopFocusGeneration=0;
window.massionDesktop.onFocus(async target=>{
 const generation=++desktopFocusGeneration;
 try{
  for(let n=0;(busy||loading||reconnectRequired)&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,100));
  if(generation!==desktopFocusGeneration||busy||loading||reconnectRequired)return;
  await readChat();await shellWorksLoad();
  if(generation!==desktopFocusGeneration||shellWorksFeed!==target.feedId)return;
  if(target.decisionId){
   if(!chatOpenThread(target.memberId||''))return;
   await readChat();
   for(let n=0;chatReading&&n<100;n++)await new Promise(resolve=>setTimeout(resolve,100));
   if(generation!==desktopFocusGeneration||chatView?.feedId!==target.feedId)return;
   document.getElementById('chat-decision-'+target.decisionId)?.querySelector('button')?.focus();
  }else{
   const work=shellWorks.find(work=>work.missionId===target.missionId&&work.workId===target.workId&&work.turnId===target.turnId);
   if(work)await shellOpenWork(work.turnId);
  }
 }catch{}
});
