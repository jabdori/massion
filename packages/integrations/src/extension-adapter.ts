import type { TenantContext } from "@massion/identity";

import type { IntegrationPlatform } from "./contracts.js";

export function createOfficialExtensionConnectorInvoker(gateway: {
  invoke(
    context: TenantContext,
    input: {
      readonly packageName: string;
      readonly contribution: string;
      readonly payload: unknown;
      readonly timeoutMs: number;
    },
  ): Promise<unknown>;
}) {
  return {
    async invoke(context: TenantContext, platform: IntegrationPlatform, contribution: string, input: unknown) {
      return await gateway.invoke(context, {
        packageName: `@massion-ext/${platform}`,
        contribution,
        payload: input,
        timeoutMs: 2_000,
      });
    },
  };
}
