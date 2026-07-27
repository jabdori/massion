import { CheckCircle, WarningCircle } from "@phosphor-icons/react";

import type { StepState, VerificationCriterionStatus } from "@/model";

export const stateLabel: Record<StepState, string> = {
  done: "완료",
  active: "진행 중",
  pending: "대기",
  failed: "실패",
};

// 초록은 쓰지 않고 amber는 "사람이 필요함" 전용어입니다. 진행 중만 밝게 두고 나머지는 가라앉힙니다.
export const stateClass: Record<StepState, string> = {
  done: "text-muted",
  active: "text-primary",
  pending: "text-muted",
  failed: "text-danger",
};

export const criterionStatusLabel: Record<VerificationCriterionStatus, string> = {
  passed: "통과",
  failed: "미통과",
  blocked: "막힘",
  excluded: "제외",
};

// 통과가 기본값이라 가라앉힙니다. 막힘은 사람이 손대야 풀리므로 gate 예약어를 씁니다.
export const criterionStatusClass: Record<VerificationCriterionStatus, string> = {
  passed: "text-muted",
  failed: "text-danger",
  blocked: "text-gate",
  excluded: "text-muted",
};

export function StateIcon({ state }: { state: StepState }) {
  if (state === "done")
    return <CheckCircle aria-label="완료" className="shrink-0 text-success" size={16} weight="fill" />;
  if (state === "failed")
    return <WarningCircle aria-label="실패" className="shrink-0 text-danger" size={16} weight="fill" />;
  return (
    <span
      aria-label={stateLabel[state]}
      className={`size-4 shrink-0 rounded-full border ${state === "active" ? "border-accent" : "border-muted"}`}
      role="img"
    />
  );
}
