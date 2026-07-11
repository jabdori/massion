import type { TenantContext } from "@massion/identity";

import type { ExtensionRecoveryAction } from "./recovery.js";

export function decideExtensionBootstrap(input: { readonly compliant: boolean }): "activate" {
  if (!input.compliant) throw new Error("Extension 준수 위반 database는 gateway를 활성화할 수 없습니다");
  return "activate";
}

export class ExtensionBootstrap {
  public constructor(
    private readonly compliance: { assertCompliant(context: TenantContext): Promise<void> },
    private readonly recovery: { scan(context: TenantContext): Promise<readonly ExtensionRecoveryAction[]> },
  ) {}

  public async start(
    context: TenantContext,
  ): Promise<{ readonly action: "activate"; readonly recoveryActions: number }> {
    await this.compliance.assertCompliant(context);
    decideExtensionBootstrap({ compliant: true });
    const actions = await this.recovery.scan(context);
    return { action: "activate", recoveryActions: actions.length };
  }
}
