import { useEffect, useRef, useState } from "react";

import { label, list, object, rows, type DataRecord } from "../data.js";
import { useQueryData, useQueryErrors } from "../hooks.js";
import { consoleStore } from "../services.js";
import { LoadingState, PageHeader, StatusStamp } from "../components/States.js";

const OPERATIONS = [
  "subscription.providers",
  "subscription.accounts",
  "subscription.quota",
  "subscription.policy",
  "subscription.doctor",
] as const;

type AccountOperation = "share" | "unshare" | "disconnect";
type ApprovalMode = "automatic" | "review" | "deny";

const APPROVAL_MODES: readonly ApprovalMode[] = ["automatic", "review", "deny"];

interface Confirmation {
  readonly operation: AccountOperation;
  readonly account: DataRecord;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function officialDocumentation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function accountQuota(account: DataRecord, quotaRows: readonly DataRecord[]): DataRecord | undefined {
  return (
    quotaRows.find((item) => item.accountId === account.accountId) ??
    (Array.isArray(account.windows) || account.minimumRemainingRatio !== undefined ? account : undefined)
  );
}

function declaredApprovalModes(value: unknown): readonly ApprovalMode[] {
  const declared = new Set(list(value));
  return APPROVAL_MODES.filter((mode) => declared.has(mode));
}

function providerApprovalModes(provider: DataRecord, accounts: readonly DataRecord[]): readonly ApprovalMode[] {
  if (provider.connectionSurface === "unavailable") return [];
  const runtimeCapabilities = object(provider.runtimeCapabilities);
  const approvalModesBySurface = object(runtimeCapabilities.approvalModesBySurface);
  const connectedSurfaces = new Set(
    accounts
      .filter((account) => account.providerId === provider.providerId)
      .map((account) => account.connectorLocation)
      .filter((surface): surface is "server" | "edge" => surface === "server" || surface === "edge"),
  );
  if (connectedSurfaces.size > 0 && Object.keys(approvalModesBySurface).length > 0) {
    const supported = new Set<ApprovalMode>();
    for (const surface of connectedSurfaces) {
      for (const mode of declaredApprovalModes(approvalModesBySurface[surface])) supported.add(mode);
    }
    return APPROVAL_MODES.filter((mode) => supported.has(mode));
  }
  if (!Object.hasOwn(runtimeCapabilities, "approvalModes")) return APPROVAL_MODES;
  return declaredApprovalModes(runtimeCapabilities.approvalModes);
}

function approvalModeLabel(mode: ApprovalMode): string {
  if (mode === "automatic") return "자동 허용 (capability 범위 안)";
  if (mode === "review") return "사람에게 확인";
  return "도구 호출 차단";
}

function QueryIssue({
  operation,
  title,
  errors,
}: {
  readonly operation: string;
  readonly title: string;
  readonly errors: Readonly<Record<string, string>>;
}) {
  if (!errors[operation]) return null;
  return (
    <div className="subscription-query-error" role="alert">
      <strong>{title}</strong>
      <span>이 정보만 불러오지 못했습니다. 연결 상태와 서버 권한을 확인해 주세요.</span>
    </div>
  );
}

function QuotaWindow({ window, alias }: { readonly window: DataRecord; readonly alias: string }) {
  const ratio = numeric(window.remainingRatio);
  return (
    <article className="quota-window">
      <header>
        <strong>{label(window.kind, "사용량 창")}</strong>
        <span>{ratio === undefined ? "잔여 비율 확인 불가" : `${String(Math.round(ratio * 100))}% 남음`}</span>
      </header>
      {ratio === undefined ? (
        <div className="quota-unknown">Provider가 잔여 비율을 공개하지 않았습니다.</div>
      ) : (
        <progress value={ratio} max={1} aria-label={`${alias} ${label(window.kind, "사용량 창")} 남은 할당량`} />
      )}
      <dl>
        <div>
          <dt>남은 양</dt>
          <dd>{numeric(window.remaining) === undefined ? "확인 불가" : String(window.remaining)}</dd>
        </div>
        <div>
          <dt>초기화</dt>
          <dd>{label(window.resetsAt, "확인 불가")}</dd>
        </div>
        <div>
          <dt>신뢰도</dt>
          <dd>{label(window.confidence, "확인 불가")}</dd>
        </div>
      </dl>
    </article>
  );
}

function AccountConfirmation({
  confirmation,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly confirmation: Confirmation;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const title =
    confirmation.operation === "share"
      ? "계정 공유 확인"
      : confirmation.operation === "unshare"
        ? "공유 해제 확인"
        : "연결 해제 확인";
  const action =
    confirmation.operation === "share"
      ? "공유 확정"
      : confirmation.operation === "unshare"
        ? "공유 해제 확정"
        : "연결 해제 확정";

  useEffect(() => {
    cancelRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab" && !event.shiftKey && document.activeElement === confirmRef.current) {
        event.preventDefault();
        cancelRef.current?.focus();
      } else if (event.key === "Tab" && event.shiftKey && document.activeElement === cancelRef.current) {
        event.preventDefault();
        confirmRef.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
    };
  }, [busy, onCancel]);

  return (
    <div className="subscription-modal-backdrop">
      <section
        className="subscription-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subscription-dialog-title"
      >
        <p className="eyebrow">EXPLICIT CONFIRMATION</p>
        <h2 id="subscription-dialog-title">{title}</h2>
        <p>
          <strong>{label(confirmation.account.alias)}</strong> 계정의 공유 범위 또는 연결 상태가 변경됩니다. 실행 중인
          모델 경로에도 영향을 줄 수 있습니다.
        </p>
        <div className="decision-actions">
          <button ref={cancelRef} type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
            취소
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={confirmation.operation === "disconnect" ? "secondary-button danger" : "primary-button"}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "처리 중…" : action}
          </button>
        </div>
      </section>
    </div>
  );
}

export default function SubscriptionsPage() {
  const providersData = useQueryData<unknown>(consoleStore, "subscription.providers");
  const accountsData = useQueryData<unknown>(consoleStore, "subscription.accounts");
  const quotaData = useQueryData<unknown>(consoleStore, "subscription.quota");
  const policyData = useQueryData<unknown>(consoleStore, "subscription.policy");
  const doctorData = useQueryData<unknown>(consoleStore, "subscription.doctor");
  const identityData = useQueryData<unknown>(consoleStore, "identity.me");
  const queryErrors = useQueryErrors(consoleStore);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [policyDrafts, setPolicyDrafts] = useState<Readonly<Record<string, string>>>({});
  const [approvalDrafts, setApprovalDrafts] = useState<Readonly<Record<string, string>>>({});

  const pending = OPERATIONS.some(
    (operation, index) =>
      [providersData, accountsData, quotaData, policyData, doctorData][index] === undefined && !queryErrors[operation],
  );
  if (pending) return <LoadingState label="구독 계정과 Provider 상태를 확인하고 있습니다" />;

  const providers = rows(providersData);
  const accounts = rows(accountsData);
  const quota = rows(quotaData);
  const policies = rows(policyData);
  const doctors = rows(doctorData);
  const role = label(object(identityData).role, "member");
  const canConfigurePolicy = role === "owner" || role === "admin";

  async function refreshAccountData(): Promise<void> {
    await Promise.allSettled([
      consoleStore.refresh("subscription.accounts", {}),
      consoleStore.refresh("subscription.quota", {}),
      consoleStore.refresh("subscription.doctor", {}),
    ]);
  }

  async function confirmAccountOperation(): Promise<void> {
    if (!confirmation || confirmation.account.canManage !== true) return;
    const accountId = confirmation.account.accountId;
    const version = confirmation.account.version;
    if (typeof accountId !== "string" || !Number.isSafeInteger(version)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: `subscription.account.${confirmation.operation}`,
        expectedRevision: version as number,
        payload: { accountId },
      });
      await refreshAccountData();
      setNotice("구독 계정 변경이 서버 정본에 반영되었습니다.");
      setConfirmation(undefined);
    } catch {
      setNotice("구독 계정을 변경하지 못했습니다. 현재 version과 권한을 다시 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function configurePolicy(provider: DataRecord): Promise<void> {
    const providerId = provider.providerId;
    if (typeof providerId !== "string" || !canConfigurePolicy || provider.connectionSurface === "unavailable") return;
    const current = policies.find((item) => item.providerId === providerId);
    const credentialPolicy = policyDrafts[providerId] ?? label(current?.credentialPolicy, "");
    const approvalMode = approvalDrafts[providerId] ?? label(current?.approvalMode, "review");
    if (!list(provider.credentialPolicies).includes(credentialPolicy)) return;
    if (!providerApprovalModes(provider, accounts).includes(approvalMode as ApprovalMode)) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await consoleStore.mutate({
        schemaVersion: "massion.application.v1",
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        operation: "subscription.policy.configure",
        ...(Number.isSafeInteger(current?.version) ? { expectedRevision: current?.version as number } : {}),
        payload: { providerId, credentialPolicy, approvalMode },
      });
      await consoleStore.refresh("subscription.policy", {});
      setNotice("Provider별 계정 선택 정책을 적용했습니다.");
    } catch {
      setNotice("계정 선택 정책을 적용하지 못했습니다. 권한과 정책 version을 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        index="08 / SUBSCRIPTIONS"
        title="모델 구독을 어떻게 사용하고 있나요?"
        description="로컬 구독 계정의 연결 건강, 공개된 할당량과 Provider별 순환 정책을 한곳에서 관리합니다."
      />

      <aside className="subscription-enrollment-note" aria-labelledby="subscription-connect-title">
        <div>
          <p className="eyebrow">LOCAL ENROLLMENT ONLY</p>
          <h2 id="subscription-connect-title">계정 연결은 로컬 Connector에서 시작합니다.</h2>
          <p>
            이 화면은 OAuth 또는 device login이 끝난 것처럼 가장하지 않습니다. 터미널에서 아래 명령을 실행하거나 Edge
            Connector 등록 절차를 완료해 주세요.
          </p>
        </div>
        <code>mass subscription connect &lt;provider&gt;</code>
      </aside>

      <div className="subscription-notice" role="status" aria-live="polite">
        {notice ?? `${String(accounts.length)}개 계정의 공개 운영 상태를 표시하고 있습니다.`}
      </div>

      <section className="subscription-section" aria-labelledby="subscription-account-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ACCOUNT CONTROL</span>
            <h2 id="subscription-account-title">구독 계정과 Connector 건강</h2>
          </div>
        </div>
        <QueryIssue operation="subscription.accounts" title="계정 목록 조회 실패" errors={queryErrors} />
        <QueryIssue operation="subscription.quota" title="할당량 조회 실패" errors={queryErrors} />
        <QueryIssue operation="subscription.doctor" title="Connector 진단 조회 실패" errors={queryErrors} />
        {accounts.length === 0 ? (
          <div className="subscription-empty">
            연결된 구독 계정이 없습니다. 로컬 Connector에서 등록을 시작해 주세요.
          </div>
        ) : (
          <div className="subscription-account-grid">
            {accounts.map((account) => {
              const quotaRow = accountQuota(account, quota);
              const windows = rows(quotaRow?.windows);
              const doctor = doctors.find((item) => item.accountId === account.accountId);
              const minimum = numeric(quotaRow?.minimumRemainingRatio);
              const canManage = account.canManage === true;
              const organizationScope = account.scope === "organization";
              return (
                <article className="subscription-account-card" key={label(account.accountId)}>
                  <header>
                    <div>
                      <span>{label(account.providerId)}</span>
                      <h3>{label(account.alias)}</h3>
                    </div>
                    <StatusStamp value={label(account.status, "unknown")} />
                  </header>
                  <dl className="subscription-facts">
                    <div>
                      <dt>공유 범위</dt>
                      <dd>{organizationScope ? "조직 공유" : "개인 전용"}</dd>
                    </div>
                    <div>
                      <dt>결제 방식</dt>
                      <dd>{label(account.billingKind)}</dd>
                    </div>
                    <div>
                      <dt>Connector</dt>
                      <dd>{label(doctor?.connectorStatus ?? account.connectorStatus, "unavailable")}</dd>
                    </div>
                    <div>
                      <dt>진단 조치</dt>
                      <dd>{label(doctor?.action, "inspect")}</dd>
                    </div>
                  </dl>
                  <div className="quota-summary">
                    <span>남은 할당량</span>
                    <strong>
                      {minimum === undefined ? "할당량 확인 불가" : `${String(Math.round(minimum * 100))}%`}
                    </strong>
                  </div>
                  <div className="quota-window-list">
                    {windows.map((window, index) => (
                      <QuotaWindow
                        key={`${label(window.kind)}-${String(index)}`}
                        window={window}
                        alias={label(account.alias)}
                      />
                    ))}
                  </div>
                  {canManage ? (
                    <div className="subscription-account-actions">
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={() => {
                          setConfirmation({ operation: organizationScope ? "unshare" : "share", account });
                        }}
                      >
                        {organizationScope ? "조직 공유 해제" : "조직에 공유"}
                      </button>
                      <button
                        type="button"
                        className="secondary-button danger"
                        disabled={busy}
                        onClick={() => {
                          setConfirmation({ operation: "disconnect", account });
                        }}
                      >
                        연결 해제
                      </button>
                    </div>
                  ) : (
                    <p className="subscription-readonly">공유한 소유자만 이 계정을 변경할 수 있습니다.</p>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="subscription-section" aria-labelledby="subscription-provider-title">
        <div className="section-heading">
          <div>
            <span className="eyebrow">ROUTING POLICY</span>
            <h2 id="subscription-provider-title">Provider별 계정 선택 정책</h2>
            <p>선택지는 서버의 Provider 카탈로그가 공개한 값만 사용합니다.</p>
          </div>
        </div>
        <QueryIssue operation="subscription.providers" title="Provider 목록 조회 실패" errors={queryErrors} />
        <QueryIssue operation="subscription.policy" title="정책 조회 실패" errors={queryErrors} />
        <div className="subscription-provider-grid">
          {providers.map((provider, index) => {
            const providerId = label(provider.providerId, "");
            const policy = policies.find((item) => item.providerId === provider.providerId);
            const options = list(provider.credentialPolicies);
            const value = policyDrafts[providerId] ?? label(policy?.credentialPolicy, options[0] ?? "");
            const selectId = `subscription-policy-${String(index)}`;
            const allowedApprovalModes = providerApprovalModes(provider, accounts);
            const requestedApprovalMode = approvalDrafts[providerId] ?? label(policy?.approvalMode, "review");
            const approvalMode = allowedApprovalModes.includes(requestedApprovalMode as ApprovalMode)
              ? (requestedApprovalMode as ApprovalMode)
              : (allowedApprovalModes[0] ?? "");
            const approvalId = `subscription-approval-${String(index)}`;
            const documentation = officialDocumentation(provider.officialDocumentation);
            const runtimeCapabilities = object(provider.runtimeCapabilities);
            const hasRuntimeCapabilities = Object.keys(runtimeCapabilities).length > 0;
            const connectionUnavailable = provider.connectionSurface === "unavailable";
            return (
              <article className="subscription-provider-card" key={providerId}>
                <header>
                  <div>
                    <span>{label(provider.executionKind).toUpperCase()}</span>
                    <h3>{label(provider.displayName)}</h3>
                  </div>
                  <StatusStamp value={label(provider.availability, "unknown")} />
                </header>
                <dl className="subscription-facts">
                  <div>
                    <dt>인증</dt>
                    <dd>{list(provider.authKinds).join(", ") || "확인 불가"}</dd>
                  </div>
                  <div>
                    <dt>할당량 검색</dt>
                    <dd>{label(provider.quotaDiscovery)}</dd>
                  </div>
                  <div>
                    <dt>연결 위치</dt>
                    <dd>{label(provider.connectionSurface)}</dd>
                  </div>
                  {hasRuntimeCapabilities ? (
                    <>
                      <div>
                        <dt>계정 격리</dt>
                        <dd>{label(runtimeCapabilities.accountIsolation)}</dd>
                      </div>
                      <div>
                        <dt>실행 성숙도</dt>
                        <dd>{label(runtimeCapabilities.maturity)}</dd>
                      </div>
                      <div>
                        <dt>실행 승인 범위</dt>
                        <dd>{list(runtimeCapabilities.approvalModes).join(", ") || "확인 불가"}</dd>
                      </div>
                    </>
                  ) : null}
                  <div>
                    <dt>현재 정책</dt>
                    <dd>{label(policy?.credentialPolicy, "서버 기본값")}</dd>
                  </div>
                  <div>
                    <dt>도구 승인</dt>
                    <dd>{label(policy?.approvalMode, "review")}</dd>
                  </div>
                  <div>
                    <dt>정책 version</dt>
                    <dd>{label(policy?.version, "미설정")}</dd>
                  </div>
                </dl>
                {documentation ? (
                  <a href={documentation} target="_blank" rel="noreferrer" className="provider-documentation">
                    {label(provider.displayName)} 공식 문서
                  </a>
                ) : (
                  <span className="provider-documentation provider-documentation-unavailable">
                    공식 문서 주소 확인 불가
                  </span>
                )}
                {connectionUnavailable ? <p className="provider-documentation">공개 연결 미지원</p> : null}
                <label htmlFor={selectId}>{label(provider.displayName)} 계정 선택 정책</label>
                <select
                  id={selectId}
                  aria-label={`${label(provider.displayName)} 계정 선택 정책`}
                  value={value}
                  disabled={!canConfigurePolicy || busy || options.length === 0 || connectionUnavailable}
                  onChange={(event) => {
                    setPolicyDrafts((current) => ({ ...current, [providerId]: event.target.value }));
                  }}
                >
                  {options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
                <label htmlFor={approvalId}>{label(provider.displayName)} 도구 승인 방식</label>
                <select
                  id={approvalId}
                  aria-label={`${label(provider.displayName)} 도구 승인 방식`}
                  value={approvalMode}
                  disabled={!canConfigurePolicy || busy || allowedApprovalModes.length === 0 || connectionUnavailable}
                  onChange={(event) => {
                    setApprovalDrafts((current) => ({ ...current, [providerId]: event.target.value }));
                  }}
                >
                  {allowedApprovalModes.map((mode) => (
                    <option key={mode} value={mode}>
                      {approvalModeLabel(mode)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="primary-button"
                  disabled={
                    !canConfigurePolicy ||
                    busy ||
                    connectionUnavailable ||
                    !options.includes(value) ||
                    !allowedApprovalModes.includes(approvalMode as ApprovalMode)
                  }
                  aria-label={`${label(provider.displayName)} 정책 적용`}
                  onClick={() => void configurePolicy(provider)}
                >
                  정책 적용
                </button>
              </article>
            );
          })}
        </div>
      </section>

      {confirmation ? (
        <AccountConfirmation
          confirmation={confirmation}
          busy={busy}
          onCancel={() => {
            setConfirmation(undefined);
          }}
          onConfirm={() => {
            void confirmAccountOperation();
          }}
        />
      ) : null}
    </>
  );
}
