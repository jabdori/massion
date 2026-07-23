import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./app";
import { createFixtureDesktopService, type DesktopService } from "./desktop-service";
import { fixtureDataAdapter, type WorkView } from "./model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function service(overrides: Partial<DesktopService> = {}): DesktopService {
  return { ...createFixtureDesktopService(), ...overrides };
}

describe("AgentOS native data flow", () => {
  it("설정은 실제 읽기 전용 상태만 조회하고 자격증명 값을 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const loadSettings = vi.fn(async () => ({
      catalog: [], credentials: [{ value: "절대-표시되면-안됨" }], routes: [{ id: "route-1" }], providers: [{ id: "provider-1" }], accounts: [{ id: "account-1" }], quota: [], policy: [],
    }));
    render(<App service={service({ loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await screen.findByRole("main", { name: "설정" });
    // 네 구역이 모두 있고, 하나를 골라도 조회는 한 번뿐입니다.
    for (const title of ["모델 경로", "Provider 연결", "구독 계정", "로컬 환경"]) {
      expect(screen.getByRole("button", { name: new RegExp(title), pressed: title === "모델 경로" })).toBeInTheDocument();
    }
    await user.click(screen.getByRole("button", { name: /구독 계정/ }));
    expect(screen.getByText("연결된 구독 계정이 없습니다.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /로컬 환경/ }));
    // 조회가 없는 구역은 없다고 말합니다. 숫자 0으로 있는 척하지 않습니다.
    expect(screen.getByText(/조회가 아직 계약에 없습니다/)).toBeInTheDocument();
    expect(loadSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText("절대-표시되면-안됨")).not.toBeInTheDocument();
  });

  it("Provider 인증 연결을 순서대로 저장하고 secret을 다시 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const loadSettings = vi.fn(async () => ({ catalog: { endpoints: [{ endpointId: "endpoint-1", providerId: "openai", name: "API", baseUrl: "https://api.openai.com/v1" }] }, credentials: [], routes: [], providers: [], accounts: [], quota: [], policy: [] }));
    const registerProvider = vi.fn(async () => { calls.push("provider"); });
    const registerEndpoint = vi.fn(async () => { calls.push("endpoint"); });
    const addCredential = vi.fn(async () => { calls.push("credential"); });
    render(<App service={service({ loadSettings, registerProvider, registerEndpoint, addCredential })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: /^Provider 연결/ }));
    await user.click(await screen.findByRole("button", { name: "다른 Provider 연결" }));
    const form = await screen.findByRole("form", { name: "Provider 연결 추가" });
    await user.type(within(form).getByRole("textbox", { name: "Provider ID" }), "openai");
    await user.type(within(form).getByRole("textbox", { name: "표시 이름" }), "OpenAI");
    await user.type(within(form).getByRole("textbox", { name: "Adapter kind" }), "openai-compatible");
    await user.type(within(form).getByRole("textbox", { name: "Endpoint 이름" }), "API");
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://api.openai.com/v1");
    await user.type(within(form).getByRole("textbox", { name: "Credential label" }), "운영 키");
    await user.type(within(form).getByRole("textbox", { name: "Credential type" }), "api_key");
    const secret = within(form).getByLabelText("Credential secret");
    await user.type(secret, "never-render-this");
    await user.click(within(form).getByRole("button", { name: "Provider 연결 추가" }));

    expect(await screen.findByText("Provider 인증 연결을 추가했습니다.")).toBeInTheDocument();
    expect(calls).toEqual(["provider", "endpoint", "credential"]);
    expect(addCredential).toHaveBeenCalledWith(expect.objectContaining({ endpointId: "endpoint-1", secret: "never-render-this", priority: 0, weight: 100 }));
    expect(secret).toHaveValue("");
    expect(screen.queryByText("never-render-this")).not.toBeInTheDocument();
  });

  it("모델 프로필·라우트·후보를 설정 화면에서 차례로 구성한다", async () => {
    const user = userEvent.setup();
    const registerModel = vi.fn(async () => undefined);
    const configureRoute = vi.fn(async () => undefined);
    const addRouteCandidate = vi.fn(async () => undefined);
    const loadSettings = vi.fn(async () => ({
      catalog: { models: [{ modelProfileId: "profile-1", providerId: "openai", endpointId: "endpoint-1", modelId: "gpt-5", routeKind: "chat" }] },
      credentials: [], routes: [{ routeId: "route-1", name: "default", routeKind: "chat" }], providers: [], accounts: [], quota: [], policy: [],
    }));
    render(<App service={service({ loadSettings, registerModel, configureRoute, addRouteCandidate })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: "고급 라우팅 설정" }));
    const model = await screen.findByRole("form", { name: "모델 프로필 등록" });
    await user.type(within(model).getByRole("textbox", { name: "모델 Provider ID" }), "openai");
    await user.type(within(model).getByRole("textbox", { name: "모델 Endpoint ID" }), "endpoint-1");
    await user.type(within(model).getByRole("textbox", { name: "모델 ID" }), "gpt-5");
    await user.click(within(model).getByRole("button", { name: "모델 등록" }));
    expect(registerModel).toHaveBeenCalledWith(expect.objectContaining({ providerId: "openai", endpointId: "endpoint-1", modelId: "gpt-5", routeKind: "chat", verified: false }));

    const route = screen.getByRole("form", { name: "라우트 구성" });
    await user.type(within(route).getByRole("textbox", { name: "라우트 이름" }), "default");
    await user.click(within(route).getByRole("button", { name: "라우트 저장" }));
    expect(configureRoute).toHaveBeenCalledWith({ name: "default", routeKind: "chat" });

    const candidate = screen.getByRole("form", { name: "라우트 후보 연결" });
    await user.click(within(candidate).getByRole("button", { name: "후보 연결" }));
    expect(addRouteCandidate).toHaveBeenCalledWith({ routeId: "route-1", modelProfileId: "profile-1", priority: 0 });
  });

  it("모델 프로필 저장 실패를 설정 화면에 표시한다", async () => {
    const user = userEvent.setup();
    const registerModel = vi.fn(async () => {
      throw new Error("모델 카탈로그에 연결하지 못했습니다");
    });
    render(<App service={service({ registerModel })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: "고급 라우팅 설정" }));
    const model = await screen.findByRole("form", { name: "모델 프로필 등록" });
    await user.type(within(model).getByRole("textbox", { name: "모델 Provider ID" }), "openai");
    await user.type(within(model).getByRole("textbox", { name: "모델 Endpoint ID" }), "endpoint-1");
    await user.type(within(model).getByRole("textbox", { name: "모델 ID" }), "gpt-5");
    await user.click(within(model).getByRole("button", { name: "모델 등록" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("모델 카탈로그에 연결하지 못했습니다");
  });

  it("확장 화면은 조직에 늘어난 Capability를 버전·출처보다 먼저 보인다", async () => {
    const user = userEvent.setup();
    const loadExtensions = vi.fn(async () => [
      {
        id: "installation-notes-1",
        packageName: "@massion-ext/notes",
        version: "1.0.0",
        description: "노트를 업무에 연결합니다.",
        provenance: "official",
        installed: true,
        state: "healthy",
        contributions: [{ kind: "runtimeTools" as const, items: ["notes.search"] }],
        permissions: [{ kind: "network" as const, items: ["notes.example"] }],
      },
      {
        id: "version-calendar-1",
        packageName: "@massion-ext/calendar",
        version: "1.2.0",
        description: "팀 일정을 Work에 연결합니다.",
        provenance: "community",
        installed: false,
        contributions: [],
        permissions: [],
      },
    ]);
    const installRegistry = vi.fn(async () => ({ outcome: "awaiting-approval", approvalId: "approval-install-1" }));
    render(<App service={service({ loadExtensions, installRegistry })} />);

    await user.click(screen.getByRole("button", { name: "확장" }));
    await screen.findByRole("main", { name: "확장" });
    expect(loadExtensions).toHaveBeenCalledOnce();

    // 설치된 것이 목록에서도 상세에서도 먼저입니다. 헌법 6절이 요구하는 순서입니다.
    const detail = screen.getByRole("main", { name: "확장" }).textContent ?? "";
    expect(detail.indexOf("조직이 무엇을 할 수 있게 되나")).toBeLessThan(detail.indexOf("출처"));
    // 도메인 키가 아니라 사람의 말로 나옵니다.
    expect(screen.getByText("도구")).toBeInTheDocument();
    expect(screen.getByText("notes.search")).toBeInTheDocument();
    expect(detail).not.toContain("runtimeTools");
    // 설치된 확장에는 설치 버튼이 없습니다.
    expect(screen.queryByRole("button", { name: "설치" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /calendar/ }));
    await user.click(await screen.findByRole("button", { name: "설치" }));
    expect(await screen.findByText("설치가 승인을 기다립니다.")).toBeInTheDocument();
    expect(installRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: "version-calendar-1", environment: "production", riskClass: "medium" }),
      expect.objectContaining({ commandId: expect.any(String), correlationId: expect.any(String) }),
    );
  });

  it("설치된 확장 선택은 Registry 상세를 조회하지 않는다", async () => {
    const user = userEvent.setup();
    const loadExtensions = vi.fn(async () => [
      {
        id: "installation-calendar-1",
        packageName: "@massion-ext/calendar",
        version: "1.2.0",
        description: "",
        provenance: "official",
        installed: true,
        state: "healthy",
        contributions: [],
        permissions: [],
      },
    ]);
    const loadRegistryInfo = vi.fn(async () => {
      throw new Error("요청을 처리하지 못했습니다");
    });
    render(<App service={service({ loadExtensions, loadRegistryInfo })} />);

    await user.click(screen.getByRole("button", { name: "확장" }));
    await user.click(await screen.findByRole("button", { name: /calendar/ }));

    expect(loadRegistryInfo).not.toHaveBeenCalled();
    expect(screen.getByText("동작 중")).toBeInTheDocument();
    // 계약이 Capability를 주지 않는다는 사실을 화면이 감추지 않습니다.
    expect(screen.getByText(/조직에 무엇을 더하는지 계약이 알려주지 않습니다/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("결정 승인 직후 대기한 Registry 설치를 원래 identity로 한 번 자동 재개한다", async () => {
    const user = userEvent.setup();
    const loadExtensions = vi.fn(async () => [
      {
        id: "version-calendar-1",
        packageName: "@massion-ext/calendar",
        version: "1.2.0",
        description: "",
        provenance: "community",
        installed: false,
        contributions: [],
        permissions: [],
      },
    ]);
    const installRegistry = vi.fn()
      .mockResolvedValueOnce({ outcome: "awaiting-approval", approvalId: "approval-install-1" })
      .mockResolvedValueOnce({ outcome: "succeeded", installationId: "installation-1" });
    const approval = { id: "approval-install-1", title: "Calendar 설치", description: "설치 승인", revision: 1, status: "pending" };
    const decideApproval = vi.fn(async () => undefined);
    render(<App service={service({ decideApproval, installRegistry, loadExtensions, loadPendingApprovals: async () => [approval] })} />);

    await user.click(screen.getByRole("button", { name: "확장" }));
    await user.click(await screen.findByRole("button", { name: "설치" }));
    const initialRequest = installRegistry.mock.calls[0]?.[0];
    const identity = installRegistry.mock.calls[0]?.[1];

    await user.click(screen.getByRole("button", { name: /수신함/ }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    await user.click(within(panel).getByRole("button", { name: /승인$/ }));
    expect(decideApproval).toHaveBeenCalledWith(approval, "approve", "데스크톱 수신함에서 승인");
    await waitFor(() => expect(installRegistry).toHaveBeenCalledTimes(2));
    expect(installRegistry).toHaveBeenNthCalledWith(2, { ...initialRequest, installApprovalId: "approval-install-1" }, identity);
    // 승인한 항목은 수신함에서 사라집니다. (fixture의 차단 업무는 별개로 남습니다.)
    await waitFor(() => expect(within(panel).queryByText("Calendar 설치")).toBeNull());
    await user.click(within(panel).getByRole("button", { name: "수신함 닫기" }));
    expect(screen.getByRole("button", { name: /수신함/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "승인 반영 후 설치 재개" })).not.toBeInTheDocument();
  });

  it("사이드바를 포인터와 [ 키로 접고 확장 항목의 이름을 유지한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    expect(screen.getByRole("button", { name: "확장" })).toBeInTheDocument();
    expect(screen.getByTestId("desktop-shell").style.getPropertyValue("--sidebar-width")).toBe("150px");
    await user.click(screen.getByRole("button", { name: "사이드바 접기" }));
    expect(screen.getByTestId("desktop-shell")).toHaveAttribute("data-sidebar-collapsed", "true");
    expect(screen.getByTestId("desktop-shell").style.getPropertyValue("--sidebar-width")).toBe("4.25rem");
    await user.keyboard("[[]");
    expect(screen.getByTestId("desktop-shell")).toHaveAttribute("data-sidebar-collapsed", "false");
    expect(screen.getByTestId("desktop-shell").style.getPropertyValue("--sidebar-width")).toBe("150px");
  });

  it("수신함 배지는 선택한 업무와 무관하게 전역 미해결 항목을 유지한다", async () => {
    const user = userEvent.setup();
    const approval = {
      id: "approval-crm-access",
      title: "CRM 고객 데이터 읽기",
      description: "고객 식별정보가 포함된 데이터에 읽기 전용으로 접근합니다.",
      revision: 1,
      status: "pending",
      workId: "churn-q3",
    };
    render(<App service={service({ loadPendingApprovals: async () => [approval] })} />);

    expect(await screen.findByRole("button", { name: "수신함, 미해결 4개" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    expect(screen.getByRole("button", { name: "수신함, 미해결 4개" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "수신함, 미해결 4개" }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    expect(within(panel).getByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
    expect(within(panel).getAllByText("3분기 고객 이탈 원인 분석").length).toBeGreaterThan(0);

    await user.click(within(panel).getByRole("button", { name: "수신함 닫기" }));
    await user.click(screen.getByRole("button", { name: "수신함, 미해결 4개" }));
    expect(await screen.findByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
  });

  it("수신함 항목은 상단 행 맨 오른쪽 꺾쇠로 업무에 이동한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(await screen.findByRole("button", { name: /수신함, 미해결/ }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const approvalSource = within(panel).getByRole("button", { name: "업무로 이동: 3분기 고객 이탈 원인 분석" });
    const blockedSource = within(panel).getByRole("button", { name: "업무로 이동: 파트너 계약서 검토" });

    expect(approvalSource).toHaveTextContent("CRM 고객 데이터 읽기승인 필요");
    expect(blockedSource).toHaveTextContent("파트너 계약서 검토막힘");
    expect(approvalSource.lastElementChild?.tagName).toBe("svg");
    expect(blockedSource.lastElementChild?.tagName).toBe("svg");
    expect(approvalSource.parentElement?.tagName).toBe("H3");
    expect(blockedSource.parentElement?.tagName).toBe("H3");
    expect(within(panel).queryByText("업무 열기")).not.toBeInTheDocument();

    await user.click(blockedSource);
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    expect(screen.getByRole("main", { name: "파트너 계약서 검토" })).toBeInTheDocument();
  });

  it("수신함은 검토 대기 개선을 집계하고 해당 개선 상세로 이동한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(await screen.findByRole("button", { name: "수신함, 미해결 4개" }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const improvement = within(panel).getByRole("button", {
      name: "개선 검토 열기: 임시로 만든 계량분석 팀을 조직에 남깁니다.",
    });
    expect(improvement).toHaveTextContent("검토 대기");

    await user.click(improvement);
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const growth = await screen.findByRole("main", { name: "개선" });
    expect(within(growth).getByRole("heading", { name: "임시로 만든 계량분석 팀을 조직에 남깁니다." })).toBeInTheDocument();
  });

  it("실행 자율성은 설정에서 실제 서비스 조회를 사용한다", async () => {
    const user = userEvent.setup();
    const loadPendingApprovals = vi.fn(createFixtureDesktopService().loadPendingApprovals);
    const loadAutonomy = vi.fn(createFixtureDesktopService().loadAutonomy);
    render(<App service={service({ loadPendingApprovals, loadAutonomy })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await user.click(await screen.findByRole("button", { name: /실행 자율성/ }));
    expect(screen.getByRole("region", { name: "자율성 경계" })).toBeInTheDocument();
    await waitFor(() => {
      expect(loadPendingApprovals).toHaveBeenCalledOnce();
      expect(loadAutonomy).toHaveBeenCalledOnce();
    });
  });

  it("성장 화면은 승인 근거가 있는 저장 기록만 읽기 전용으로 표시한다", async () => {
    const user = userEvent.setup();
    const loadGrowth = vi.fn(async () => ({
      configuration: {
        reflectionEnabled: true,
        adoptionMode: "review" as const,
        governanceDecisionId: "decision-growth-0001",
        activatedAt: "2026-07-22T00:00:00.000Z",
      },
      memories: [
        {
          memoryVersionId: "memory-0001",
          scope: "organization",
          subjectId: "organization",
          version: 3,
          status: "active",
          entryKeys: ["verification-required"],
          sourceReferenceIds: ["record-work-0001"],
          checksum: "a".repeat(64),
        },
      ],
      suggestions: [
        {
          suggestionId: "suggestion-0001",
          workId: "work-0001",
          targetKind: "memory",
          operation: "add-entry",
          summary: "검증 근거 보강",
          rationale: "기록된 검증 누락을 줄이기 위해",
          expectedEffect: "검증 계보 보강",
          riskSummary: "검토 필요",
          status: "awaiting-review",
        },
      ],
      effects: [{ effectEvaluationId: "effect-0001", adoptionId: "adoption-0001", result: "improved" }],
    }));
    render(<App service={service({ loadGrowth } as Partial<DesktopService>)} />);

    await user.click(screen.getByRole("button", { name: "개선" }));

    // 마스터-디테일이므로 요약은 목록과 본문 양쪽에 있습니다.
    expect(await screen.findAllByText("검증 근거 보강")).toHaveLength(2);
    expect(screen.getByText(/decision-growth-0001/)).toBeInTheDocument();
    expect(screen.getByText(/record-work-0001/)).toBeInTheDocument();
    // 판단에 필요한 증거가 순서대로 있어야 합니다. 요약만 보고 채택하면 승인 버튼 하나와 같습니다.
    expect(screen.getByRole("region", { name: "왜" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "승인하면" })).toBeInTheDocument();
    // 어떤 작업에서 올라온 제안인지 추적할 수 있어야 합니다.
    expect(screen.getByRole("region", { name: "어디서 나왔나" })).toBeInTheDocument();
    expect(screen.getByText("개선 확인")).toBeInTheDocument();
    expect(loadGrowth).toHaveBeenCalledOnce();

    // 채택 command가 아직 없으므로 이 화면은 아무것도 실행하지 않습니다.
    // 문구가 아니라 disabled로 검사해야 나중에 버튼 라벨이 바뀌어도 규칙이 지켜집니다.
    expect(screen.getByRole("button", { name: "검증 근거 보강 승인" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "검증 근거 보강 거절" })).toBeDisabled();
    expect(screen.getByText("승인·거절 명령이 아직 연결되지 않았습니다")).toBeInTheDocument();
  });

  it("성장 기록이 없으면 검증된 실행 기록을 기다리는 빈 상태를 표시한다", async () => {
    const user = userEvent.setup();
    const loadGrowth = vi.fn(async () => ({ memories: [], suggestions: [], effects: [] }));
    render(<App service={service({ loadGrowth })} />);

    await user.click(screen.getByRole("button", { name: "개선" }));

    expect(await screen.findByText("조직이 아직 바꾸자고 제안한 것이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("저장된 기억이 없습니다.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("늦게 끝난 이전 Work 조회가 최신 선택을 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const second = snapshot.works[1];
    const third = snapshot.works[2];
    if (!second || !third) throw new Error("Work fixture가 부족합니다");
    const secondRequest = deferred<WorkView>();
    const thirdRequest = deferred<WorkView>();
    const fake = service({
      loadWork: (workId) => {
        if (workId === second.id) return secondRequest.promise;
        if (workId === third.id) return thirdRequest.promise;
        return Promise.resolve(snapshot.works[0] as WorkView);
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: /파트너 계약서 검토/ }));
    await user.click(screen.getByRole("button", { name: /주간 운영 보고서/ }));
    thirdRequest.resolve(third);
    expect(await screen.findByRole("main", { name: third.title })).toBeInTheDocument();
    secondRequest.resolve(second);
    await Promise.resolve();
    expect(screen.getByRole("main", { name: third.title })).toBeInTheDocument();
  });

  it("구독 등록이 unmount 뒤 끝나도 stop을 실행한다", async () => {
    const pending = deferred<() => Promise<void>>();
    const stop = vi.fn(async () => undefined);
    const fake = service({ subscribeDurable: async () => await pending.promise });
    const view = render(<App service={fake} />);

    view.unmount();
    pending.resolve(stop);

    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("등록된 stream 정리 실패를 unhandled rejection으로 남기지 않는다", async () => {
    const subscribed = deferred<void>();
    const stop = vi.fn(async () => {
      throw new Error("이미 종료된 stream입니다");
    });
    const fake = service({
      subscribeDurable: async () => {
        subscribed.resolve();
        return stop;
      },
    });
    const view = render(<App service={fake} />);
    await subscribed.promise;

    view.unmount();

    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });

  it("지시 제출 실패 시 입력을 보존하고 중복 제출을 막는다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const first = snapshot.works[0];
    if (!first) throw new Error("Work fixture가 없습니다");
    const active = {
      ...first,
      revision: 4,
      run: { runId: "run-fixture-1", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const submitDirective = vi.fn(async () => {
      throw new Error("지시를 저장하지 못했습니다");
    });
    const fake = service({
      initialSnapshot: { works: [active] },
      loadIndex: async () => [active],
      loadWork: async () => active,
      submitDirective,
    });
    render(<App service={fake} />);

    const input = screen.getByRole("textbox", { name: "추가 지시" });
    await user.type(input, "산업군별 이탈률도 분리해줘");
    await user.click(screen.getByRole("button", { name: "다음 단계에 반영" }));

    expect(await screen.findByText("지시를 저장하지 못했습니다")).toBeInTheDocument();
    expect(input).toHaveValue("산업군별 이탈률도 분리해줘");
    expect(submitDirective).toHaveBeenCalledOnce();
  });

  it("새 Work 실행을 임시 행으로 표시하고 재조회된 Work를 자동 선택한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-0001",
      title: "파트너 계약 위험 검토",
      run: { runId: "run-created-0001", status: "running", stage: "evidence", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    const startWork = vi.fn(async () => ({ runId: "run-created-0001" }));
    const fake = service({
      startWork,
      loadIndex: async () => (createdVisible ? [...snapshot.works, created] : snapshot.works),
      loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "파트너 계약 위험을 검토해줘");
    await user.type(within(dialog).getByRole("textbox", { name: /워크스페이스 ID/ }), "workspace-0001");
    await user.click(within(dialog).getByRole("button", { name: "실행 시작" }));

    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();
    expect(screen.getByText("run-created-0001")).toBeInTheDocument();
    expect(startWork).toHaveBeenCalledWith({ text: "파트너 계약 위험을 검토해줘", workspaceId: "workspace-0001" });

    createdVisible = true;
    durable?.({ sequence: 12, type: "work.created", resource: { type: "Work", id: created.id } });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
  });

  it("새 Work 요청 실패 시 입력을 보존하고 중복 실행을 막는다", async () => {
    const user = userEvent.setup();
    const started = deferred<{ runId: string }>();
    const startWork = vi.fn(async () => await started.promise);
    render(<App service={service({ startWork })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    const workspace = within(dialog).getByRole("textbox", { name: /워크스페이스 ID/ });
    const submit = within(dialog).getByRole("button", { name: "실행 시작" });
    await user.type(request, "월간 운영 지표를 분석해줘");
    await user.type(workspace, "workspace-0002");
    await user.click(submit);
    await user.click(submit);

    expect(startWork).toHaveBeenCalledOnce();
    started.reject(new Error("실행을 시작하지 못했습니다"));
    expect(await within(dialog).findByText("실행을 시작하지 못했습니다")).toBeInTheDocument();
    expect(request).toHaveValue("월간 운영 지표를 분석해줘");
    expect(workspace).toHaveValue("workspace-0002");
  });

  it("동시에 생긴 다른 Work는 자동 선택하지 않고 run 계보가 맞는 Work만 선택한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const foreign = {
      ...(snapshot.works[1] as WorkView),
      id: "work-foreign-0001",
      title: "다른 사용자의 Work",
      run: { runId: "run-foreign-0001", status: "running", stage: "evidence", leaseGeneration: 1 },
    };
    const created = {
      ...(snapshot.works[2] as WorkView),
      id: "work-owned-0001",
      title: "내가 요청한 Work",
      run: { runId: "run-owned-0001", status: "running", stage: "evidence", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let visible: "base" | "foreign" | "both" = "base";
    const fake = service({
      startWork: async () => ({ runId: "run-owned-0001" }),
      loadIndex: async () =>
        visible === "base"
          ? snapshot.works
          : visible === "foreign"
            ? [...snapshot.works, foreign]
            : [...snapshot.works, foreign, created],
      loadWork: async (workId) => {
        if (workId === foreign.id) return foreign;
        if (workId === created.id) return created;
        return snapshot.works.find((value) => value.id === workId) as WorkView;
      },
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "내 운영 보고서를 만들어줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));

    visible = "foreign";
    durable?.({ sequence: 21, type: "work.created", resource: { type: "Work", id: foreign.id } });
    await waitFor(() => expect(screen.getByText("run-owned-0001")).toBeInTheDocument());
    expect(screen.getByRole("main")).not.toHaveAccessibleName(foreign.title);

    visible = "both";
    durable?.({ sequence: 22, type: "work.created", resource: { type: "Work", id: created.id } });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByText("run-owned-0001")).not.toBeInTheDocument();
  });

  it("승인 대기 run에는 재개를 노출하지 않고 blocked run만 재개한다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const awaiting = {
      ...base,
      run: { runId: "run-awaiting-0001", status: "awaiting-approval", stage: "evidence", leaseGeneration: 1 },
    };
    const resumeRun = vi.fn(async () => undefined);
    const awaitingService = service({
      initialSnapshot: { works: [awaiting] },
      loadIndex: async () => [awaiting],
      loadWork: async () => awaiting,
      resumeRun,
    });
    const view = render(<App service={awaitingService} />);
    expect(screen.queryByRole("button", { name: "실행 재개" })).not.toBeInTheDocument();
    view.unmount();

    const blocked = {
      ...base,
      run: { runId: "run-blocked-0001", status: "blocked", stage: "evidence", leaseGeneration: 2 },
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork: async () => blocked,
          resumeRun,
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "실행 재개" }));
    expect(resumeRun).toHaveBeenCalledWith(blocked);
  });
});
