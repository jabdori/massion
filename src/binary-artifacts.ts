import {crc32,deflateSync,inflateSync} from 'node:zlib';
import type {Artifact} from './domain.ts';
import {ArtifactByteStore} from './text-artifacts.ts';

export const BINARY_MAX_BYTES=1_048_576;
export type BinaryKind='application/pdf'|'image/png';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const fail=():never=>{throw new TypeError('Unsupported or invalid bounded binary artifact');};

function chunk(type:string,data:Buffer):Buffer {
 const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(type,4,'ascii');data.copy(bytes,8);bytes.writeUInt32BE(crc32(bytes.subarray(4,-4)),bytes.length-4);return bytes;
}
function dimensions(width:number,height:number):void {if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>512||height>512)fail();}
/** 외부 파일이나 주소 대신 호출자가 제공한 RGB 픽셀만 인코딩합니다. */
export function producePng(width:number,height:number,pixels:Uint8Array):Buffer {
 dimensions(width,height);if(!(pixels instanceof Uint8Array)||pixels.byteLength!==width*height*3)fail();
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const scan=Buffer.alloc(height*(1+width*3));for(let row=0;row<height;row++)scan.set(pixels.subarray(row*width*3,(row+1)*width*3),row*(1+width*3)+1);
 return Buffer.concat([PNG,chunk('IHDR',header),chunk('IDAT',deflateSync(scan)),chunk('IEND',Buffer.alloc(0))]);
}
/** 한 페이지의 정적 텍스트만 담으며 링크, 스크립트, 첨부 파일을 만들지 않습니다. */
export function producePdf(text:string):Buffer {
 if(typeof text!=='string'||!text.length||text.length>3_879||!/^[\x20-\x7e\n]+$/.test(text))fail();const lines=text.split('\n');if(lines.length>40||lines.some(line=>line.length>96))fail();
 const commands='BT\n/F1 10 Tf\n14 TL\n40 800 Td\n'+lines.map((line,i)=>(i?'T*\n':'')+'('+line.replace(/[\\()]/g,'\\$&')+') Tj\n').join('')+'ET\n';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>','<< /Length '+commands.length+' >>\nstream\n'+commands+'endstream'];
 let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,object] of objects.entries()){offsets.push(pdf.length);pdf+=(i+1)+' 0 obj\n'+object+'\nendobj\n';}
 const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+xref+'\n%%EOF\n';return Buffer.from(pdf,'ascii');
}
/** 임의 PDF 파서 대신 이 생산기의 정적 부분집합만 완전 일치로 허용합니다. */
function inspectBinary(kind:string,content:Uint8Array):()=>string {
 if(!(content instanceof Uint8Array)||!content.byteLength||content.byteLength>BINARY_MAX_BYTES)fail();const bytes=Buffer.from(content);
 if(kind==='application/pdf'){
  const text=bytes.toString('ascii'),stream=/\nstream\nBT\n\/F1 10 Tf\n14 TL\n40 800 Td\n([\s\S]*?)ET\nendstream\n/.exec(text);if(!stream)fail();
  const body=stream![1]!,lines=[...body.matchAll(/\(((?:\\[\\()]|[^\\()\n])*)\) Tj\n/g)].map(match=>match[1]!.replace(/\\([\\()])/g,'$1'));
  if(!lines.length||!producePdf(lines.join('\n')).equals(bytes))fail();return ()=>lines.join('\n');
 }
 if(kind!=='image/png'||!bytes.subarray(0,8).equals(PNG))fail();
 let offset=8;const chunks:Buffer[]=[];
 for(const type of ['IHDR','IDAT','IEND']){
  if(offset+12>bytes.length)fail();const length=bytes.readUInt32BE(offset);if(length>BINARY_MAX_BYTES||offset+length+12>bytes.length||bytes.toString('ascii',offset+4,offset+8)!==type)fail();
  const end=offset+length+8;if(crc32(bytes.subarray(offset+4,end))!==bytes.readUInt32BE(end))fail();chunks.push(bytes.subarray(offset+8,end));offset=end+4;
 }
 const [header,data,end]=chunks as [Buffer,Buffer,Buffer];if(offset!==bytes.length||header.length!==13||end.length||!header.subarray(8).equals(Buffer.from([8,2,0,0,0])))fail();
 const width=header.readUInt32BE(0),height=header.readUInt32BE(4);dimensions(width,height);const size=height*(1+width*3),scan=inflateSync(data,{maxOutputLength:size,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
 if(scan.buffer.length!==size||scan.engine.bytesWritten!==data.length)fail();for(let row=0;row<height;row++)if(scan.buffer[row*(1+width*3)]!==0)fail();
 return ()=>{if(width*height*7+height+32>32_768)fail();const rows=[];for(let row=0;row<height;row++){const pixels=[];for(let col=0;col<width;col++){const start=row*(1+width*3)+1+col*3;pixels.push('#'+scan.buffer.subarray(start,start+3).toString('hex'));}rows.push(pixels.join(' '));}return 'RGB '+width+'x'+height+'\n'+rows.join('\n');};
}
export function validateBinary(kind:string,content:Uint8Array):void {inspectBinary(kind,content);}
/** 검증자의 인용은 생산자의 주장 대신 실제 파일에서 복원한 내용에 묶습니다. */
export function binaryArtifactText(kind:string,content:Uint8Array):string {const text=inspectBinary(kind,content)();if(Buffer.byteLength(text,'utf8')>32_768)fail();return text;}

export class BinaryArtifactStore extends ArtifactByteStore {
 constructor(root:string){super(root,BINARY_MAX_BYTES,{'application/pdf':'pdf','image/png':'png'},'binary');}
 async write(workId:string,version:number,kind:string,content:Uint8Array):Promise<Artifact>{if(!(content instanceof Uint8Array)||!content.byteLength||content.byteLength>BINARY_MAX_BYTES)fail();const bytes=Buffer.from(content);validateBinary(kind,bytes);return this.writeBytes(workId,version,kind,bytes);}
 override async readBytes(artifact:Artifact):Promise<Buffer>{const pinned={...artifact},bytes=await super.readBytes(pinned);validateBinary(pinned.kind,bytes);return bytes;}
 override async snapshot(artifact:Artifact):Promise<{sha256:string;path:string}>{const pinned={...artifact};await this.readBytes(pinned);return super.snapshot(pinned);}
}
