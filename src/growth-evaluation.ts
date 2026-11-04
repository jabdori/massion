import {createHash} from 'node:crypto';
import {DomainError,hash,canonical,memoryVersionHash} from './domain.ts';
import type {Memory} from './domain.ts';
export const ROUNDING_ORACLE='rounding-calculation/v1';
export interface OrderCase {items:{unitPriceCents:number;quantity:number}[];discountBasisPoints:number}
export function keys(value:unknown,allowed:readonly string[]):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw new DomainError('Only supported exact input fields are accepted');}
export function orderCases(value:unknown):OrderCase[]{
 if(!Array.isArray(value)||value.length<1||value.length>32)throw new DomainError('Provide 1 to 32 bounded input orders; expected results and scores are host-owned');
 for(const c of value){keys(c,['items','discountBasisPoints']);if(!Array.isArray(c.items)||c.items.length>16||!Number.isSafeInteger(c.discountBasisPoints)||Number(c.discountBasisPoints)<0||Number(c.discountBasisPoints)>10000)throw new DomainError('Invalid bounded order');let sum=0;for(const item of c.items){keys(item,['unitPriceCents','quantity']);if(!Number.isSafeInteger(item.unitPriceCents)||Number(item.unitPriceCents)<0||Number(item.unitPriceCents)>1000000||!Number.isSafeInteger(item.quantity)||Number(item.quantity)<1||Number(item.quantity)>1000)throw new DomainError('Invalid bounded price or quantity');sum+=Number(item.unitPriceCents)*Number(item.quantity);}if(sum>1000000000)throw new DomainError('Order subtotal exceeds bound');}
 return structuredClone(value) as OrderCase[];
}
export function policy(memory:Memory):'line'|'aggregate'{if(memory.content==='Round each line')return 'line';if(memory.content==='Round aggregate once')return 'aggregate';throw new DomainError('Unsupported calculation memory. Supported exact policies: Round each line / Round aggregate once. No arbitrary text or code execution.');}
export function calculationPlan(baseline:Memory,candidate:Memory,cases:OrderCase[]){
 const modes=[policy(baseline),policy(candidate)];
 const reports=modes.map(mode=>cases.map(c=>{const factor=10000-c.discountBasisPoints,subtotal=c.items.reduce((n,i)=>n+BigInt(i.unitPriceCents)*BigInt(i.quantity),0n),expected=Number((subtotal*BigInt(factor)+5000n)/10000n);const actual=mode==='aggregate'?Math.round(Number(subtotal)*factor/10000):c.items.reduce((n,i)=>n+Math.round(i.unitPriceCents*i.quantity*factor/10000),0);return {expected,actual,passed:actual===expected};}));
 const source=`let raw='';for await(const chunk of process.stdin)raw+=chunk;const {orders,modes}=JSON.parse(raw);const reports=modes.map(mode=>orders.map(c=>{const factor=10000-c.discountBasisPoints;const subtotal=c.items.reduce((n,i)=>n+i.unitPriceCents*i.quantity,0);return mode==='aggregate'?Math.round(subtotal*factor/10000):c.items.reduce((n,i)=>n+Math.round(i.unitPriceCents*i.quantity*factor/10000),0);}));process.stdout.write(JSON.stringify(reports));`;
 const oracleHash=createHash('sha256').update(source).digest('hex');
 const heldOut=canonical({oracle:ROUNDING_ORACLE,oracleHash,evidenceClass:'bounded-local-calculation',scope:'Order-level half-up integer-cent discount rule only; caller-supplied orders, not secret holdout or model learning',baseline:{ref:baseline.id+'@'+baseline.version,hash:memoryVersionHash(baseline)},candidate:{ref:candidate.id+'@'+candidate.version,hash:memoryVersionHash(candidate)},inputHash:hash(cases),orders:cases,reports});
 if(Buffer.byteLength(heldOut,'utf8')>16000)throw new DomainError('Bounded evaluation evidence exceeds 16000 UTF-8 bytes; use fewer input orders');
 return {source,input:Buffer.from(JSON.stringify({orders:cases,modes})),expected:reports.map(r=>r.map(c=>c.actual)),baseline:reports[0]!.filter(r=>r.passed).length,candidate:reports[1]!.filter(r=>r.passed).length,heldOut};
}
