// Work composer — nimbalyst AIInput 컴포넌트를 그대로 가져와 Massion 메시지 송신에 배선.
// barrel(@nimbalyst/runtime/ui) 대신 AIInput 진입점을 직접 import하여 AgentTranscript의
// 무거운 체인(lexical · extension-sdk/file-tree)이 번들에 끼어드는 것을 막습니다.
// AIInput은 react + 자체 CSS(.ai-input-*)로 자족하며 tailwind/lexical 없이 동작합니다.
// shim(vendor-shims.d.ts)이 타입을 any로, vite alias가 빌드 시 실제 vendor 소스로 연결합니다.
import { AIInput } from "@nimbalyst/runtime/ui/AIInput";

export interface WorkComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: (message: string) => void;
  readonly disabled?: boolean;
  readonly isLoading?: boolean;
  readonly placeholder?: string;
}

export function WorkComposer({ value, onChange, onSend, disabled, isLoading, placeholder }: WorkComposerProps) {
  return (
    <AIInput
      value={value}
      onChange={onChange}
      onSend={onSend}
      disabled={disabled}
      isLoading={isLoading}
      placeholder={placeholder ?? "작업에 대해 질문이나 추가 지시를 입력하세요… (Enter로 전송, Shift+Enter 줄바꿈)"}
    />
  );
}
