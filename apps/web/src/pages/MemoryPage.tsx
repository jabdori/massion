import { label, list, rows, shortId } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function MemoryPage() {
  const data = useQueryData<unknown>(consoleStore, "growth.memories");
  if (data === undefined) return <LoadingState label="채택된 기억을 읽고 있습니다" />;
  const memories = rows(data);
  return (
    <>
      <PageHeader
        index="05 / ADOPTED MEMORY"
        title="조직은 무엇을 기억하고 있나요?"
        description="채택된 기억의 범위, 출처와 버전만 보여줍니다. 비공개 원문과 모델 추론은 노출하지 않습니다."
      />
      {memories.length === 0 ? (
        <EmptyState
          title="채택된 기억이 없습니다"
          detail="업무 회고에서 검증된 제안이 채택되면 출처와 버전이 이곳에 기록됩니다."
        />
      ) : (
        <section className="memory-grid">
          {memories.map((memory) => (
            <article key={label(memory.memoryVersionId)}>
              <header>
                <StatusStamp value={label(memory.scope)} />
                <span>V{label(memory.version)}</span>
              </header>
              <h2>{label(memory.subjectId)}</h2>
              <p className="mono">{shortId(memory.memoryVersionId)}</p>
              <div className="memory-keys">
                {list(memory.entryKeys).map((key) => (
                  <span key={key}>{key}</span>
                ))}
              </div>
              <footer>
                <span>출처 {list(memory.sourceReferenceIds).length}개</span>
                <code>{shortId(memory.checksum)}</code>
              </footer>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
