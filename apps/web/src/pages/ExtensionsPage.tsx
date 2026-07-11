import { useState } from "react";

import { label, object, rows, shortId } from "../data.js";
import { useQueryData } from "../hooks.js";
import { consoleStore } from "../services.js";
import { EmptyState, LoadingState, PageHeader, StatusStamp } from "../components/States.js";

export default function ExtensionsPage() {
  const data = useQueryData<unknown>(consoleStore, "extension.list");
  const integrationData = useQueryData<unknown>(consoleStore, "integration.list");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<string>();
  if (data === undefined || integrationData === undefined)
    return <LoadingState label="확장과 외부 연결 상태를 확인하고 있습니다" />;
  const extensions = rows(data);
  const integrations = rows(integrationData);

  async function startOAuth(platform: "slack" | "github") {
    setBusy(platform);
    setNotice(undefined);
    try {
      const redirectUri = `${window.location.origin}/integrations/${platform === "slack" ? "slack/oauth" : "github/setup"}/callback`;
      const response = object(
        await consoleStore.mutate({
          schemaVersion: "massion.application.v1",
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          operation: "integration.oauth.start",
          payload: {
            platform,
            redirectUri,
            scopes: platform === "slack" ? ["commands", "chat:write"] : [],
          },
        }),
      );
      const authorizeUrl = label(object(response.data).authorizeUrl, "");
      const target = new URL(authorizeUrl);
      if (
        (platform === "slack" && target.origin !== "https://slack.com") ||
        (platform === "github" && target.origin !== "https://github.com")
      )
        throw new Error("공식 OAuth 주소를 확인할 수 없습니다");
      window.location.assign(target.toString());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "외부 연결을 시작하지 못했습니다.");
      setBusy(undefined);
    }
  }
  return (
    <>
      <PageHeader
        index="06 / EXTENSIONS"
        title="어떤 확장이 운영체제에 연결됐나요?"
        description="설치 버전, 신뢰 수준, 활성 상태와 기여 기능을 확인합니다."
      />
      <section className="section-heading">
        <div>
          <span className="eyebrow">OFFICIAL SURFACES</span>
          <h2>Slack·Discord·GitHub 연결</h2>
          <p>확인된 외부 사용자와 허용한 채널·저장소만 같은 Work와 승인 원장에 연결됩니다.</p>
        </div>
        <div className="decision-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== undefined}
            onClick={() => void startOAuth("slack")}
          >
            {busy === "slack" ? "Slack 이동 중…" : "Slack 연결"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busy !== undefined}
            onClick={() => void startOAuth("github")}
          >
            {busy === "github" ? "GitHub 이동 중…" : "GitHub 연결"}
          </button>
        </div>
      </section>
      <div className="live-notice" role="status" aria-live="polite">
        {notice ?? `${String(integrations.length)}개의 공식 외부 연결이 활성화되어 있습니다.`}
      </div>
      {integrations.length === 0 ? (
        <EmptyState
          title="연결된 외부 Surface가 없습니다"
          detail="OAuth 또는 CLI로 공식 Extension을 연결한 뒤 사용자와 채널을 명시적으로 허용해주세요."
        />
      ) : (
        <section className="extension-table" aria-label="공식 외부 연결">
          <div className="table-head">
            <span>플랫폼</span>
            <span>외부 조직</span>
            <span>허용 위치</span>
            <span>상태</span>
            <span>설치 ID</span>
          </div>
          {integrations.map((item) => (
            <article key={label(item.installationId)}>
              <strong>{label(item.platform)}</strong>
              <span>{label(item.externalTenantId)}</span>
              <span>{String(rows(item.channels).length)}</span>
              <StatusStamp value={label(item.state)} />
              <code>{shortId(item.installationId)}</code>
            </article>
          ))}
        </section>
      )}
      <section className="section-heading">
        <div>
          <span className="eyebrow">EXTENSION RUNTIME</span>
          <h2>설치된 실행 확장</h2>
        </div>
      </section>
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
