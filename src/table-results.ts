export interface TableResult {format:'massion-table/v1';caption:string;columns:string[];rows:string[][];business?:'pricing'}

/** 명시적인 표만 해석하며 기존 텍스트의 바이트와 의미는 바꾸지 않습니다. */
export function parseTableResult(text:string):TableResult|null {
 if(typeof text!=='string'||text.length>32768||!text.isWellFormed()||new TextEncoder().encode(text).length>32768)return null;
 let value;try{value=JSON.parse(text);}catch{return null;}
 if(!value||value.format!=='massion-table/v1'||Object.keys(value).length!==(Object.hasOwn(value,'business')?5:4)||!['format','caption','columns','rows'].every(key=>Object.hasOwn(value,key))||Object.hasOwn(value,'business')&&value.business!=='pricing')return null;
 const label=(s:unknown)=>typeof s==='string'&&s.isWellFormed()&&!!s.trim()&&s.length<=128;
 if(!label(value.caption)||!Array.isArray(value.columns)||value.columns.length<1||value.columns.length>12||!value.columns.every(label)||!Array.isArray(value.rows)||value.rows.length<1||value.rows.length>100||value.rows.length*value.columns.length>600)return null;
 if(!value.rows.every((row:unknown)=>Array.isArray(row)&&row.length===value.columns.length&&row.every(cell=>typeof cell==='string'&&cell.isWellFormed()&&cell.length<=1024)))return null;
 return value;
}

export function validateTableOutput(text:string):void {
 let value;try{value=JSON.parse(text);}catch{return;}
 if(value?.format==='massion-table/v1'&&!parseTableResult(text))throw new Error('Invalid bounded table result');
}

export const TABLE_RESULT_FORMAT=' When the owner requests a table, return exactly JSON {"format":"massion-table/v1","caption":"Table title","columns":["Column"],"rows":[["Cell"]]}. Use only string cells, 1–12 nonempty columns, 1–100 rectangular rows, at most 600 cells, 128 characters per caption/header, 1024 characters per cell, at most 32768 UTF-8 bytes. For a table whose rows actually represent pricing plans, an optional business:"pricing" field declares that meaning explicitly; all other tables omit business. No Markdown fences, HTML or inferred facts.';

export const tableResultsClient=`const parseTableResult=${parseTableResult.toString()};`+String.raw`
function tableResultElement(text){
 const value=parseTableResult(text);if(!value)return null;
 const table=element('table',undefined,'typed-result-table'),head=element('thead'),headers=element('tr'),body=element('tbody');
 table.append(element('caption',value.caption));
 for(const label of value.columns){const cell=element('th');cell.textContent=label;cell.setAttribute('scope','col');headers.append(cell);}head.append(headers);
 for(const row of value.rows){const line=element('tr');for(const text of row){const cell=element('td');cell.textContent=text;line.append(cell);}body.append(line);}
 table.append(head,body);return table;
}
`;

export const tableResultsStyle=String.raw`.typed-result-table{width:100%;border-collapse:collapse;background:var(--bg-0);font-size:var(--type-pane-text-size);line-height:var(--type-pane-text-line-height);white-space:normal;overflow-wrap:anywhere}.typed-result-table caption{text-align:left;padding:var(--space-8) var(--space-12);font-weight:var(--type-pane-heading-weight)}.typed-result-table th,.typed-result-table td{padding:var(--space-6) var(--space-12);text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}.typed-result-table th{color:var(--fg-4);font-weight:500}.typed-result-table td{font-variant-numeric:tabular-nums}`;
