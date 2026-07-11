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
    private readonly workers: {
      recoverActive(context: TenantContext): Promise<{ readonly recovered: number; readonly blocked: number }>;
    },
  ) {}

  public async start(
    context: TenantContext,
  ): Promise<{ readonly action: "activate"; readonly recoveryActions: number; readonly recoveredWorkers: number }> {
    await this.compliance.assertCompliant(context);
    decideExtensionBootstrap({ compliant: true });
    const actions = await this.recovery.scan(context);
    const workers = await this.workers.recoverActive(context);
    if (workers.blocked > 0) {
      throw new Error(`active Extension worker 복원에 실패했습니다: ${String(workers.blocked)}`);
    }
    return { action: "activate", recoveryActions: actions.length, recoveredWorkers: workers.recovered };
  }
}
