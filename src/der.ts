/** Minimal DER writers shared by the two certificate assemblers (database start, device link).
 * Node crypto owns all signing; these only assemble the certificate structure. */
/** Lengths above 2^24-1 are refused rather than mis-encoded: that bound keeps the long form within
 * three length bytes and is far beyond any X.509 certificate (the ones built here are ~330 bytes),
 * while the 32-bit shift below would already be wrong from 2^31 on. */
const maxDerLength=2**24-1;
export const derLength=(length:number)=>{if(!Number.isSafeInteger(length)||length<0||length>maxDerLength)throw new Error('a DER length must be a non-negative safe integer of at most 2^24-1');if(length<128)return Buffer.from([length]);const bytes:number[]=[];let n=length;while(n>0){bytes.unshift(n&255);n>>=8;}return Buffer.from([0x80|bytes.length,...bytes]);};
export const der=(tag:number,content:Buffer)=>Buffer.concat([Buffer.from([tag]),derLength(content.length),content]);
export const sequence=(...parts:Buffer[])=>der(0x30,Buffer.concat(parts));
/** A minimal, non-negative DER INTEGER: leading zero bytes are stripped, one zero byte is
 * prepended when the high bit is set, and an empty or all-zero input encodes the value zero. */
export const derInt=(value:Buffer)=>{let v=value;while(v.length>1&&v[0]===0)v=v.subarray(1);if(!v.length)v=Buffer.from([0]);return der(0x02,v[0]!&0x80?Buffer.concat([Buffer.from([0]),v]):v);};
/** Refuses what this encoder cannot write correctly instead of emitting wrong DER: fewer than two
 * arcs, a first arc above 2, a second arc past X.680's 0-39 (0-47 under arc 2, the most the
 * single-byte first sub-identifier holds), and later sub-identifiers from 2^31 up, where the
 * 32-bit shift below would already be wrong. */
export const derOid=(...parts:number[])=>{
 if(parts.length<2)throw new Error('an OID needs a first and a second arc');
 if(!parts.every(part=>Number.isSafeInteger(part)&&part>=0))throw new Error('every OID arc must be a non-negative integer');
 const [first,second,...rest]=parts;
 if(first!>2||second!>(first===2?47:39))throw new Error('the first arc must be 0-2 and the second 0-39 (0-47 under arc 2)');
 const body:number[]=[first!*40+second!];
 for(const part of rest){
  if(part>=2**31)throw new Error('an OID sub-identifier must stay below 2^31');
  let n=part;const stack=[n&127];n>>=7;while(n>0){stack.unshift(128|(n&127));n>>=7;}body.push(...stack);
 }
 return der(0x06,Buffer.from(body));
};
/** RFC 5280 time: UTCTime before 2050, GeneralizedTime from 2050 on. */
export const derTime=(at:number)=>{const d=new Date(at),p=(v:number)=>String(v).padStart(2,'0'),body=`${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;return d.getUTCFullYear()<2050?der(0x17,Buffer.from(`${p(d.getUTCFullYear()%100)}${body}`)):der(0x18,Buffer.from(`${d.getUTCFullYear()}${body}`));};
