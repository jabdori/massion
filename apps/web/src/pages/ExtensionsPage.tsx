import { label, rows, shortId } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function ExtensionsPage() {
  const data = useQueryData<unknown>(consoleStore, "extension.list");
  if (data === undefined) return <LoadingState label="확장 설치 상태를 확인하고 있습니다" />;
  const extensions = rows(data);
  return (
    <>
      <PageHeader
        index="06 / EXTENSIONS"
        title="어떤 확장이 운영체제에 연결됐나요?"
        description="설치 버전, 신뢰 수준, 활성 상태와 기여 기능을 확인합니다."
      />
      {extensions.length === 0 ? (
        <EmptyState
          title="설치된 확장이 없습니다"
          detail="검증된 npm 호환 레지스트리 패키지를 설치하면 여기에 나타납니다."
        />
      ) : (
        <section className="extension-table">
          <div className="table-head">
            <span>패키지</span>
            <span>버전</span>
            <span>신뢰</span>
            <span>상태</span>
            <span>설치 ID</span>
          </div>
          {extensions.map((item) => (
            <article key={label(item.installationId)}>
              <strong>{label(item.packageName)}</strong>
              <span>{label(item.packageVersion)}</span>
              <StatusStamp value={label(item.trustLevel)} />
              <StatusStamp value={label(item.state)} />
              <code>{shortId(item.installationId)}</code>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
