/** Host-owned family map (ADR 0003 §3, §7): (provider, model) → developer. Unknown is null and counts as the same family. Changing this file changes the checking rules: an owner decision, never a candidate. */
import {familyRelation} from './domain.ts';
import type {CheckFamily} from './domain.ts';
const PROVIDERS=new Map([['openai','openai'],['codex-cli','openai'],['anthropic','anthropic'],['claude-code-cli','anthropic'],['gemini','google'],['zai','zhipu']]);
const VENDORS=new Map([['openai','openai'],['anthropic','anthropic'],['google','google'],['z-ai','zhipu'],['zai','zhipu'],['meta-llama','meta'],['mistralai','mistral'],['deepseek','deepseek'],['qwen','alibaba'],['x-ai','xai']]);
/** A compatible endpoint can serve anything under any name, so only first-party providers and the known OpenRouter/Codex routing prefixes are trusted. */
export function modelFamily(provider:string,model:string):string|null {return provider==='codex-cli'&&model.includes('/')||provider==='openrouter'?VENDORS.get(model.split('/')[0]!)??null:PROVIDERS.get(provider)??null;}
export function familyCheck(producers:readonly {provider:string;model:string}[],checker:{provider:string;model:string}):CheckFamily {
 const id=(m:{provider:string;model:string})=>({provider:m.provider,model:m.model,family:modelFamily(m.provider,m.model)});const p=producers.map(id),c=id(checker);return {relation:familyRelation(p,c),producers:p,checker:c};
}
/** The one gate for automatic Growth or self-made skill adoption: a host evaluator or a different family, never a same-family model check. */
export const supportsAutomaticAdoption=(check:CheckFamily|undefined)=>check?.relation==='deterministic'||check?.relation==='different-family';
