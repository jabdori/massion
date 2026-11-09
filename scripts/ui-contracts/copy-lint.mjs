import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {API} from 'typescript/unstable/sync';
import {createVirtualFileSystem} from 'typescript/unstable/fs';
import * as ts from 'typescript/unstable/ast';

const dynamic='\uFFFC';
const attributes=new Set(['title','placeholder','alt','aria-label','aria-description']);
const properties=new Set(['textContent','innerText','title','placeholder','alt','ariaLabel','ariaDescription']);
const keyedFiles=new Set([
 'work-room-panel.ts','surface-shell.ts','assistant-conversation-panel.ts','settings-panel.ts','apps-panel.ts','members-panel.ts','results-panel.ts','schedules-panel.ts','workbench.ts',
 'conversation-work-panel.ts','expired-run-panel.ts','knowledge-neighborhood-panel.ts','memory-conflict-panel.ts','memory-content-search-panel.ts','memory-expiry-panel.ts','memory-find-panel.ts','memory-usage-panel.ts',
 'mission-catalog-panel.ts','mission-constraints-panel.ts','reflection-trail-panel.ts','rejected-text-panel.ts','run-sequence-panel.ts','work-clarification-panel.ts','work-correction-panel.ts','work-inbox-panel.ts','work-prerequisite-panel.ts',
 'accepted-result-source-draft.ts','owner-file-document-draft.ts'
].map(name=>`src/${name}`));
const normalize=text=>text.normalize('NFC').replace(/\s+/g,' ').trim();
const canonical=text=>normalize(text).replace(/\{[\w]+\}/g,dynamic);
const limits=[
 'Static extraction only: dynamic data, variable aliases, lookup tables and indirect helper arguments are not resolved.',
 'Recognizes direct DOM writes, element(tag, text), HTML-shaped literals, inline scripts and templates assigned to names ending in Client.',
 'HTML scanning is not a browser parser: hidden markup is included; CSS content, computed visibility, custom entities and cross-element text composition are not checked.',
 'Migrated panels, shell, workbench and the two rendered source helpers require keyed copy; other panels report only and match approved normalized ko text. Symbols and numbers are not copy. Roles, screens and runtime interpolation values are not validated. Escaped literal columns are approximate.',
 'Direct copy calls validate static keys and object placeholder names. Dynamic keys/values and missing properties behind spreads or computed names are not resolved.'
];
function decode(text){
 const entities={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
 return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(whole,key)=>{
  if(key[0]!=='#')return entities[key.toLowerCase()];
  const value=key[1].toLowerCase()==='x'?parseInt(key.slice(2),16):Number(key.slice(1));
  return value>0&&value<=0x10ffff?String.fromCodePoint(value):whole;
 });
}

export async function lintCopy(root=fileURLToPath(new URL('../../',import.meta.url))){
 const tablePath=resolve(root,'docs/product/screens/copy.ko.json');
 let table;
 try{table=JSON.parse(await readFile(tablePath,'utf8'));}
 catch(error){throw new Error(`Cannot read approved copy table ${tablePath}: ${error.message}`);}
 if(!table||Array.isArray(table)||!Object.keys(table).length||Object.values(table).some(entry=>typeof entry?.ko!=='string'||!entry.ko.trim()))throw new Error(`Invalid approved copy table: ${tablePath}`);
 const approved=new Set(Object.values(table).map(entry=>canonical(entry.ko)));
 const files=(await readdir(resolve(root,'src'))).filter(name=>/panel\.ts$/.test(name)||keyedFiles.has(`src/${name}`)).sort().map(name=>`src/${name}`);
 const findings=[];
  for(const file of files){
   const source=await readFile(resolve(root,file),'utf8'),seen=new Set(),blocking=keyedFiles.has(file);
   function report(text,position,context,reason){
    text=normalize(text);
    if(!reason&&(!/[\p{L}]/u.test(text.replaceAll(dynamic,''))||!blocking&&approved.has(canonical(text))))return;
    reason??=blocking?'unkeyed-copy':/[a-z]/i.test(text.replaceAll(dynamic,''))?'english-copy':'unapproved-copy';
    const key=`${position}:${reason}:${text}`;
    if(seen.has(key))return;
    seen.add(key);
    const before=source.slice(0,position),line=before.split('\n').length,column=position-before.lastIndexOf('\n');
    findings.push({file,line,column,context,reason,blocking,text:text.replaceAll(dynamic,'{dynamic}')});
   }
   function scan(code,base=0){
    // A fresh virtual project avoids cached source bytes across embedded clients.
    const fs=createVirtualFileSystem({'/copy-lint/tsconfig.json':JSON.stringify({compilerOptions:{noLib:true,noResolve:true,types:[]},files:['source.ts']}),'/copy-lint/source.ts':code});
    const api=new API({fs,cwd:'/copy-lint'});
    try{
     const snapshot=api.updateSnapshot({openProjects:['/copy-lint/tsconfig.json']});
     const ast=snapshot.getProject('/copy-lint/tsconfig.json').program.getSourceFile('/copy-lint/source.ts');
     const literal=node=>node&&(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node));
     const member=node=>ts.isPropertyAccessExpression(node)?node.name.text:ts.isElementAccessExpression(node)&&literal(node.argumentExpression)?node.argumentExpression.text:'';
     const lookup=node=>ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='copy';
     function validateCopy(node){
      const [key,values]=node.arguments,position=base+node.getStart();
      if(!key){report('copy()',position,'copy-call','missing-copy-key');return;}
      if(!literal(key))return;
      if(!Object.hasOwn(table,key.text)){report(key.text,position,'copy-call','unknown-copy-key');return;}
      const expected=new Set([...table[key.text].ko.matchAll(/\{(\w+)\}/g)].map(match=>match[1])),provided=new Set();
      const absent=!values||values.kind===ts.SyntaxKind.NullKeyword||ts.isIdentifier(values)&&values.text==='undefined';
      let complete=absent;
      if(values&&ts.isObjectLiteralExpression(values)){
       complete=true;
       for(const property of values.properties){
        let name=property.name;
        if(name&&ts.isComputedPropertyName(name))name=literal(name.expression)?name.expression:undefined;
        if(!name||!ts.isIdentifier(name)&&!literal(name)){complete=false;continue;}
        provided.add(name.text);
       }
      }else if(!absent)return;
      if(complete)for(const name of expected)if(!provided.has(name))report(`${key.text}: ${name}`,position,'copy-call','missing-copy-placeholder');
      for(const name of provided)if(!expected.has(name))report(`${key.text}: ${name}`,position,'copy-call','unknown-copy-placeholder');
     }
     function value(node){
      if(!node)return dynamic;
      if(literal(node))return node.text;
      if(ts.isTaggedTemplateExpression(node))return value(node.template);
      if(ts.isParenthesizedExpression(node))return value(node.expression);
      if(ts.isTemplateExpression(node))return node.head.text+node.templateSpans.map(span=>value(span.expression)+span.literal.text).join('');
      if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.PlusToken)return value(node.left)+value(node.right);
      return dynamic;
     }
     function visible(node,context){
      if(!node)return;
      if(ts.isParenthesizedExpression(node))return visible(node.expression,context);
      if(ts.isConditionalExpression(node)){visible(node.whenTrue,context);visible(node.whenFalse,context);return;}
      if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken,ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)){
       if(node.operatorToken.kind!==ts.SyntaxKind.AmpersandAmpersandToken)visible(node.left,context);
       visible(node.right,context);return;
      }
      report(value(node),base+node.getStart(),context);
     }
     function markup(node){
      const start=node.getStart()+1,end=node.end-1,expressions=[];
      let html=code.slice(start,end);
      if(ts.isTemplateExpression(node)){
       for(const span of [...node.templateSpans].reverse()){
        const from=span.expression.pos-2,to=span.literal.getStart()+1;
        expressions.push({node:span.expression,position:from-start});
        const masked=dynamic+code.slice(from+1,to).replace(/[^\r\n]/g,' ');
        html=html.slice(0,from-start)+masked+html.slice(to-start);
       }
      }
      htmlScan(html,base+start,(text,position,context)=>{
       for(const entry of expressions)if(entry.position>=position&&entry.position<position+text.length)visible(entry.node,context);
       report(decode(text),base+start+position,context);
      });
     }
     function htmlScan(html,offset,emit){
      // shortcut: bounded HTML tokenization, use a full parser if production markup needs malformed-tag recovery.
      const tokens=/<!--[\s\S]*?-->|<(script|style)\b[^>]*>([\s\S]*?)<\/\1\s*>|<(?:"[^"]*"|'[^']*'|[^>"'])*>|[^<]+/gi;
      for(const token of html.matchAll(tokens)){
       const text=token[0],position=token.index;
       if(token[1]){if(token[1].toLowerCase()==='script')scan(token[2],offset+position+text.indexOf('>')+1);continue;}
       if(text.startsWith('<!--')||/^<\//.test(text)||/^<!/.test(text))continue;
       if(!text.startsWith('<')){emit(text,position,'html-text');continue;}
       const tag=/^<([\w-]+)/.exec(text)?.[1]?.toLowerCase();
       const attrs=[...text.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)];
       const type=attrs.find(attr=>attr[1].toLowerCase()==='type');
       for(const attr of attrs){
        const name=attr[1].toLowerCase(),content=attr[2]??attr[3]??attr[4];
        if(attributes.has(name)||(name==='label'&&['option','optgroup','track'].includes(tag))||(name==='value'&&(tag==='button'||tag==='input'&&/^(button|submit|reset)$/i.test(type?.[2]??type?.[3]??type?.[4]??''))))emit(content,position+attr.index+attr[0].indexOf('=')+1,'html-attribute');
       }
      }
     }
     function visit(node){
      if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.EqualsToken,ts.SyntaxKind.PlusEqualsToken].includes(node.operatorToken.kind)){
       const name=member(node.left);
       if(properties.has(name))visible(node.right,`dom-${name}`);
       if(['innerHTML','outerHTML'].includes(name)&&(literal(node.right)||ts.isTemplateExpression(node.right)))markup(node.right);
      }
      if(ts.isCallExpression(node)){
       if(lookup(node))validateCopy(node);
       const name=member(node.expression),args=node.arguments;
       if(name==='setAttribute'&&literal(args[0])&&attributes.has(args[0].text))visible(args[1],'dom-attribute');
       if(name==='createTextNode'||name==='insertAdjacentText')visible(args[name==='insertAdjacentText'?1:0],'dom-text');
       if(name==='insertAdjacentHTML'&&args[1]&&(literal(args[1])||ts.isTemplateExpression(args[1])))markup(args[1]);
       if(['append','prepend','replaceChildren'].includes(name))for(const arg of args)visible(arg,'dom-text');
       if(ts.isIdentifier(node.expression)&&node.expression.text==='element')visible(args[1],'element-text');
      }
      if(literal(node)||ts.isTemplateExpression(node)){
       for(let parent=node.parent;parent;parent=parent.parent)if(lookup(parent)){node.forEachChild(visit);return;}
       const first=literal(node)?node.text:node.head.text;
       const parent=ts.isTaggedTemplateExpression(node.parent)?node.parent.parent:node.parent;
       if(ts.isVariableDeclaration(parent)&&/Client$/i.test(parent.name.getText())){
        const start=node.getStart()+1;
        // Keep source positions while removing host interpolations from embedded JavaScript.
        let client=code.slice(start,node.end-1);
        if(ts.isTemplateExpression(node))for(const span of [...node.templateSpans].reverse()){
         const from=span.expression.pos-2,to=span.literal.getStart()+1;
         client=client.slice(0,from-start)+code.slice(from,to).replace(/[^\r\n]/g,' ')+client.slice(to-start);
        }
        scan(client,base+start);
       }else if(/^\s*<(?:[a-z]|!doctype)/i.test(first))markup(node);
      }
      node.forEachChild(visit);
     }
     visit(ast);
    }finally{api.close();}
   }
   scan(source);
  }
 findings.sort((a,b)=>a.file.localeCompare(b.file,'en')||a.line-b.line||a.column-b.column);
 return {mode:'scoped-blocking',files,findings,limits};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const report=await lintCopy(process.argv[2]);console.log(JSON.stringify(report,null,2));if(report.findings.some(item=>item.blocking))process.exitCode=1;}
 catch(error){console.error(`Copy lint infrastructure error: ${error.message}`);process.exitCode=1;}
}
