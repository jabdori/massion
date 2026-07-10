export interface RuntimeIntake {
  stopAccepting(): void;
}

export interface RuntimeDrain {
  activeExecutionIds(): readonly string[];
  cancel(executionId: string, reason: string): Promise<void>;
}

export interface RuntimeFlusher {
  flush(): Promise<void>;
}

export interface ClosableRuntime {
  shutdown(): Promise<void>;
}

export interface ClosableDatabase {
  close(): Promise<void>;
}

export class RuntimeShutdown {
  public constructor(
    private readonly intake: RuntimeIntake,
    private readonly drain: RuntimeDrain,
    private readonly flusher: RuntimeFlusher,
    private readonly runtime: ClosableRuntime,
    private readonly database: ClosableDatabase,
  ) {}

  public async shutdown(reason = "runtime_shutdown"): Promise<void> {
    this.intake.stopAccepting();
    await Promise.all(
      this.drain.activeExecutionIds().map(async (executionId) => {
        await this.drain.cancel(executionId, reason);
      }),
    );
    await this.flusher.flush();
    await this.runtime.shutdown();
    await this.database.close();
  }
}
