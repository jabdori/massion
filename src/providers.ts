/** Configuration/selection contracts. No implicit provider, network call or platform credentials. */
export interface ProviderDescriptor {
  provider:string; model:string; configVersion:string; enabled:boolean;
  capabilities:readonly string[]; evidenceClass:'fixture'|'real-provider';
}
export interface ProviderRequest { invocationId:string; workId:string; instruction:string; inputReferences:readonly string[]; signal:AbortSignal }
export interface ProviderOutcome {
  status:'completed'|'failed'|'cancelled'|'unknown';
  output:string|null; usage:{inputTokens:number|null;outputTokens:number|null};
  reason:string;
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
