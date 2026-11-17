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
   * bounded by USAGE_LIMIT_RESETS_TEXT_CHARS, and anything outside that drops the fragment and keeps the reason. */
  usageLimitResetsText?:string;
}
/** The bounded shape of ProviderOutcome.usageLimitResetsText: the provider's own words (not a parsed date),
 * at most 64 characters of digits, letters, colon, space and a few punctuation marks. A fragment outside this is
 * dropped and the reason code kept (issue #206). */
export const USAGE_LIMIT_RESETS_TEXT_CHARS=/^[A-Za-z0-9 ,:]{1,64}$/;
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
