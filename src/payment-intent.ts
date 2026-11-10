import {DomainError} from './domain.ts';
import {boundedPlainJson} from './bounded-json.ts';

export interface PaymentIntent {kind:'payment-intent';payee:string;amountMinor:number;currency:string;purpose:string;sourceReference:string}
// SIX List One, published 2026-09-17: pin minor units for stable journal replay.
const minorUnits:Readonly<Record<string,number>>=Object.freeze({
 ...Object.fromEntries('BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF'.split(' ').map(code=>[code,0])),
 ...Object.fromEntries('AED AFN ALL AMD AOA ARS AUD AWG AZN BAM BBD BDT BMD BND BOB BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS VED VES WST XAD XCD XCG YER ZAR ZMW ZWG'.split(' ').map(code=>[code,2])),
 ...Object.fromEntries('BHD IQD JOD KWD LYD OMR TND'.split(' ').map(code=>[code,3])),
 CLF:4,UYW:4,
});
export const PAYMENT_INTENT_FORMAT=' If a payment is needed, do not execute it or claim it happened. Return only JSON {"format":"massion-payment-intent/v1","payee":"payee label","amountMinor":123,"currency":"USD","purpose":"payment purpose","sourceReference":"declared source reference"}. amountMinor is a positive integer in ISO 4217 minor units taken only from explicit source data, never token budgets or an inferred amount. No extra fields, credentials or card data. This declaration requests an owner decision only; it is not a receipt.';
export function validatePaymentIntent(value:unknown):asserts value is PaymentIntent {
 boundedPlainJson(value);
 const r=value as PaymentIntent,keys=['kind','payee','amountMinor','currency','purpose','sourceReference'];
 if(!r||typeof r!=='object'||Object.keys(r).length!==keys.length||!keys.every(k=>Object.hasOwn(r,k))||r.kind!=='payment-intent')throw new DomainError('Exact payment intent fields required');
 const line=(v:unknown,max:number)=>typeof v==='string'&&v.length>0&&v.length<=max&&v.trim()===v&&!/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v);
 if(!line(r.payee,256)||!line(r.purpose,2000)||!line(r.sourceReference,512))throw new DomainError('Invalid payment intent labels');
 if(!Number.isSafeInteger(r.amountMinor)||r.amountMinor<=0||typeof r.currency!=='string'||!Object.hasOwn(minorUnits,r.currency))throw new DomainError('Invalid payment amount or ISO 4217 currency');
}
export function parsePaymentIntent(output:string):PaymentIntent|null {
 let value;try{value=JSON.parse(output);}catch{return null;}
 if(value?.format!=='massion-payment-intent/v1')return null;
 boundedPlainJson(value);const {format,...fields}=value,request={...fields,kind:'payment-intent'};
 if(Object.hasOwn(fields,'kind'))throw new DomainError('Unexpected payment kind');
 validatePaymentIntent(request);return request;
}
export function paymentAmount(r:PaymentIntent):string {
 const digits=minorUnits[r.currency]!,raw=String(r.amountMinor).padStart(digits+1,'0'),whole=digits?raw.slice(0,-digits):raw;
 const amount=BigInt(whole).toLocaleString('ko-KR')+(digits?'.'+raw.slice(-digits):'');return r.currency==='KRW'?amount+'원':amount+' '+r.currency;
}
export const paymentIntentClient=`const minorUnits=${JSON.stringify(minorUnits)};\n${paymentAmount.toString()}`;
