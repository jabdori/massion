export interface ReportRow {screen:string;passed:number;failed:number;required:number;warnings:number;visualFailures:string[];gaps:string[];errors:string[];pair:string|null}
type Outcome=Pick<ReportRow,'failed'|'visualFailures'|'gaps'|'errors'>;
type Rectangle=[number,number,number,number];
export function parseCheck(output:string){
 const summary=/^(?:PASS|FAIL): (\d+) failures, (\d+) warnings, (\d+) required elements$/m.exec(output);
 if(!summary)throw Error('Checker did not produce a summary');
 return {passed:(output.match(/^  ok    /gm)||[]).length,failed:Number(summary[1]),warnings:Number(summary[2]),required:Number(summary[3])};
}
export function exitCode(rows:Outcome[],blocking:boolean){return rows.some(row=>row.errors.length || blocking&&(row.failed || row.visualFailures.length || row.gaps.length))?1:0;}
export function checkVisual(contract:{visual?:{regions:Record<string,Rectangle|null>}},spec:{tokens:Record<string,string>},actual:{tokens:Record<string,string>;regions:Record<string,Rectangle|null>}){
 const failures=[];
 for(const [key,value] of Object.entries(spec.tokens))if(actual.tokens[key]!==value)failures.push(`token ${key}: ${JSON.stringify(actual.tokens[key]??null)} != ${JSON.stringify(value)}`);
 for(const [key,rect] of Object.entries(contract.visual?.regions||{})){
  if(!rect)continue;const got=actual.regions[key];
  if(!got||rect.some((value,index)=>Math.abs(value-got[index]!)>2))failures.push(`region ${key}: ${JSON.stringify(got??null)} != ${JSON.stringify(rect)} (2px tolerance)`);
 }
 return failures;
}
export function reportMarkdown(rows:ReportRow[],blocking:boolean){
 const clean=rows.filter(row=>!row.failed&&!row.visualFailures.length&&!row.gaps.length&&!row.errors.length).length;
 const lines=['# UI contracts','',`Mode: **${blocking?'BLOCKING':'REPORT-ONLY'}**. ${clean}/${rows.length} screens pass all measured checks; ${rows.length-clean} have drift, gaps or errors.`,'',
 'Element passes count required matches. Failures also include forbidden strings and hard text budgets; they are not required-minus-passed. Visual checks cover tokens and region rectangles, not pixel similarity. Missing state interactions and artboards are gaps. Infrastructure errors fail either mode.','',
 '| Screen | Elements passed / required | Contract failures | Warnings | Visual failures | Gaps | Errors | Pair |',
 '| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
 for(const row of rows)lines.push(`| ${row.screen} | ${row.passed} / ${row.required} | ${row.failed} | ${row.warnings} | ${row.visualFailures.length} | ${row.gaps.length} | ${row.errors.length} | ${row.pair?`[PNG](${row.pair})`:'unavailable'} |`);
 for(const row of rows){
  lines.push('',`## ${row.screen}`,'',`[Snapshot](snapshots/${row.screen}.txt) · [Checker](checks/${row.screen}.txt) · [Screenshot](screenshots/${row.screen}.png) · [Visual measurements](visual/${row.screen}.json)`);
  for(const [kind,items] of [['Gap',row.gaps],['Error',row.errors],['Visual',row.visualFailures]] as const)for(const item of items)lines.push(`- ${kind}: ${item.replaceAll('\n',' ')}`);
 }
 return lines.join('\n')+'\n';
}
export function isInteractionGap(error:unknown):boolean{
 if(!error||typeof error!=='object'||!('code' in error)||error.code!==1||!('stdout' in error)||typeof error.stdout!=='string')return false;
 try{const reply=JSON.parse(error.stdout);return reply.success===false&&typeof reply.error==='string'&&/^(Element not found:|Timeout waiting for selector[: ]|Element is not visible:|Wait timed out after \d+ms$)/.test(reply.error);}catch{return false;}
}
