import type { TenantContext } from "@massion/identity";
import type { ExecutionDelta, ExecutionDeltaObserver } from "@massion/runtime";

// Runtime의 휘발성 실행 델타를 tenant 격리된 Surface 구독자에게 fan-out합니다.
// 델타는 저장하지 않으며 재연결 복구는 work.timeline 재조회가 담당합니다.

export interface ExecutionStreamSubscription {
  readonly executionId?: string;
}

interface Subscriber {
  readonly organizationId: string;
  readonly executionId?: string;
  readonly handler: (delta: ExecutionDelta) => void;
}

export class ExecutionStreamRegistry implements ExecutionDeltaObserver {
  private readonly subscribers = new Set<Subscriber>();
  private readonly maxSubscribers: number;

  public constructor(options: { readonly maxSubscribers?: number } = {}) {
    this.maxSubscribers = options.maxSubscribers ?? 256;
    if (!Number.isSafeInteger(this.maxSubscribers) || this.maxSubscribers < 1)
      throw new Error("실행 스트림 구독 상한이 유효하지 않습니다");
  }

  public get size(): number {
    return this.subscribers.size;
  }

  public observe(context: TenantContext, delta: ExecutionDelta): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.organizationId !== context.organizationId) continue;
      if (subscriber.executionId !== undefined && subscriber.executionId !== delta.executionId) continue;
      try {
        subscriber.handler(delta);
      } catch {
        // 구독자 오류는 다른 구독자와 실행 경로에 전파하지 않습니다.
      }
    }
  }

  public subscribe(
    context: TenantContext,
    subscription: ExecutionStreamSubscription,
    handler: (delta: ExecutionDelta) => void,
  ): () => void {
    if (this.subscribers.size >= this.maxSubscribers) throw new Error("실행 스트림 구독 상한을 초과했습니다");
    const subscriber: Subscriber = {
      organizationId: context.organizationId,
      ...(subscription.executionId === undefined ? {} : { executionId: subscription.executionId }),
      handler,
    };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}
