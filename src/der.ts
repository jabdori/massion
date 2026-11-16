/** Minimal DER writers shared by the two certificate assemblers (database start, device link).
 * Node crypto owns all signing; these only assemble the certificate structure. */
export const derLength=(length:number)=>{if(length<128)return Buffer.from([length]);const bytes:number[]=[];let n=length;while(n>0){bytes.unshift(n&255);n>>=8;}return Buffer.from([0x80|bytes.length,...bytes]);};
export const der=(tag:number,content:Buffer)=>Buffer.concat([Buffer.from([tag]),derLength(content.length),content]);
export const sequence=(...parts:Buffer[])=>der(0x30,Buffer.concat(parts));
/** A minimal, non-negative DER INTEGER: leading zero bytes are stripped, one zero byte is
 * prepended when the high bit is set, and an empty or all-zero input encodes the value zero. */
export const derInt=(value:Buffer)=>{let v=value;while(v.length>1&&v[0]===0)v=v.subarray(1);if(!v.length)v=Buffer.from([0]);return der(0x02,v[0]!&0x80?Buffer.concat([Buffer.from([0]),v]):v);};
export const derOid=(...parts:number[])=>{const body:number[]=[parts[0]!*40+parts[1]!];for(const part of parts.slice(2)){let n=part;const stack=[n&127];n>>=7;while(n>0){stack.unshift(128|(n&127));n>>=7;}body.push(...stack);}return der(0x06,Buffer.from(body));};
/** RFC 5280 time: UTCTime before 2050, GeneralizedTime from 2050 on. */
export const derTime=(at:number)=>{const d=new Date(at),p=(v:number)=>String(v).padStart(2,'0'),body=`${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;return d.getUTCFullYear()<2050?der(0x17,Buffer.from(`${p(d.getUTCFullYear()%100)}${body}`)):der(0x18,Buffer.from(`${d.getUTCFullYear()}${body}`));};
