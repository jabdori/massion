// nimbalyst MarkdownRenderer 활성화를 위한 얇은 jotai store.
// MarkdownRenderer 는 trackerIssueKeyPrefixesAtom(derived)과 sessionRefMapAtom 을 읽는다.
// trackerIssueKeyPrefixesAtom은 trackerItemsMapAtom 에서 파생되므로, 원본 map atom 을 빈 Map 으로
// 초기화하면 derived 도 빈 Set 이 되어 tracker 참조 자동완성이 자연히 no-op 가 된다.
// 이로써 lexical 없이 nimbalyst 진짜 마크다운 렌더(Prism 코드 하이라이트·테이블·링크)가 동작한다.
import { Provider, createStore } from "jotai";
import { useMemo } from "react";
import type { ReactNode } from "react";

import { trackerItemsMapAtom } from "@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms";
import { sessionRefMapAtom } from "@nimbalyst/runtime/ui/AgentTranscript/session/sessionRefAtoms";

export function MarkdownProvider({ children }: { readonly children: ReactNode }) {
  // 컴포넌트 생애 주기 동안 하나의 store 를 유지합니다(빈 map 초기화).
  const store = useMemo(() => {
    const created = createStore();
    created.set(trackerItemsMapAtom, new Map());
    created.set(sessionRefMapAtom, new Map());
    return created;
  }, []);
  return <Provider store={store}>{children}</Provider>;
}
