/** Configuration/selection contracts. No implicit provider, network call or platform credentials. */
export interface ProviderDescriptor {
  provider:string; model:string; configVersion:string; enabled:boolean;
  capabilities:readonly string[]; evidenceClass:'fixture'|'real-provider';
}
export interface ProviderRequest { invocationId:string; workId:string; instruction:string; inputReferences:readonly string[]; signal:AbortSignal; maxOutputTokens?:number }
export interface ProviderOutcome {
  credentialFailure?:import('./provider-credentials.ts').CredentialFailure;
  credentialBinding?:{connectionId:string;configHash:string;generation:number};
  status:'completed'|'failed'|'cancelled'|'unknown';
  output:string|null; usage:{inputTokens:number|null;outputTokens:number|null};
  reason:string;
  /** The provider's own words for when an account usage limit lifts (Codex only, issue #206), carried verbatim and
   * never parsed, converted or given a time zone. Present only with reason `cli_usage_limit_reached`; its shape is
   * checked by isUsageLimitResetTime. */
  usageLimitResetsText?:string;
}
export const CODEX_USAGE_LIMIT_REASON='cli_usage_limit_reached';
/** Codex rust-v0.167.1, protocol/src/error.rs:867-887: %-I:%M %p or %b %-d{suffix}, %Y %-I:%M %p. */
const CODEX_RESET_TIME=/^(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?:1st|21st|31st|2nd|22nd|3rd|23rd|[4-9]th|1[0-9]th|20th|2[4-9]th|30th), (?:[0-9]{4}|-[0-9]{4,6}|\+[1-9][0-9]{4,5}) )?(?:[1-9]|1[0-2]):[0-5][0-9] (?:AM|PM)$/;
export function isUsageLimitResetTime(value:unknown):value is string{
 return typeof value==='string'&&CODEX_RESET_TIME.test(value);
}
export interface ProviderAdapter {
  descriptor:ProviderDescriptor;
  invoke(request:ProviderRequest):Promise<ProviderOutcome>;
}
export type ProviderSelection =
 | {status:'selected';descriptor:ProviderDescriptor;reason:string}
 | {status:'unavailable';code:'provider_unavailable';reason:string};
export class ProviderRegistry {
 private readonly adapters:readonly ProviderAdapter[];
 constructor(adapters:readonly ProviderAdapter[]=[]){this.adapters=[...adapters];}
 list():ProviderDescriptor[]{return this.adapters.map(a=>structuredClone(a.descriptor));}
 select(requiredCapabilities:readonly string[]):ProviderSelection {
  const selected=this.adapters.find(a=>a.descriptor.enabled&&a.descriptor.evidenceClass==='real-provider'&&requiredCapabilities.every(c=>a.descriptor.capabilities.includes(c)));
  if(!selected)return {status:'unavailable',code:'provider_unavailable',reason:'No enabled, authorized real-provider adapter satisfies this Work. Configure a provider and its permitted usage before execution; the development fixture will not be substituted.'};
  return {status:'selected',descriptor:structuredClone(selected.descriptor),reason:'Enabled real-provider configuration satisfies required capabilities; quality is not yet a measured ranking.'};
 }
}
