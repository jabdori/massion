import type { TenantContext } from "@massion/identity";

export interface RecoverableRunSource {
  listRecoverable(context: TenantContext): Promise<readonly { readonly runId: string }[]>;
}

export interface RunRecoveryTarget {
  recover(context: TenantContext, runId: string): Promise<unknown>;
}

export class ApplicationRunRecovery {
  public constructor(
    private readonly source: RecoverableRunSource,
    private readonly target: RunRecoveryTarget,
  ) {}

  public async scan(context: TenantContext): Promise<{ readonly recovered: number; readonly blocked: number }> {
    const runs = await this.source.listRecoverable(context);
    let recovered = 0;
    let blocked = 0;
    for (const run of runs) {
      try {
        await this.target.recover(context, run.runId);
        recovered += 1;
      } catch {
        blocked += 1;
      }
    }
    return { recovered, blocked };
  }
}
