import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "./app";
import {
  createFixtureDesktopService,
  type DesktopService,
  type DesktopWorkspaceView,
  type KnowledgeGraphView,
  type KnowledgeIndexView,
  type KnowledgeNodeKind,
} from "./desktop-service";
import { fixtureDataAdapter, type ActivityView, type RoomView, type SpeakerView, type WorkView } from "./model";

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

function workspaceFixture(
  workspaceId: string,
  name: string,
  path: string,
  trust: DesktopWorkspaceView["trust"],
  revision: number,
): DesktopWorkspaceView {
  return {
    workspaceId,
    name,
    path,
    kind: "local-directory",
    trust,
    status: "active",
    revision,
    createdAt: "2026-07-24T00:00:00.000Z",
    lastUsedAt: "2026-07-24T00:00:00.000Z",
  };
}

function knowledgeIndexFixture(workspaceId: string): KnowledgeIndexView {
  return {
    workspaceId,
    status: "ready",
    indexVersionId: `index-${workspaceId}`,
    fileCount: 1,
    symbolCount: 1,
    relationCount: 0,
    indexedAt: "2026-07-29T01:00:00.000Z",
    excluded: [],
  };
}

function knowledgeGraphFixture(lens: KnowledgeNodeKind, nodeId: string, label: string): KnowledgeGraphView {
  return { lens, nodes: [{ nodeId: `${lens}:${nodeId}`, kind: lens, label }], edges: [] };
}

describe("AgentOS native data flow", () => {
  it("선택한 Work의 run event는 상세 상태·계획·승인을 다시 읽는다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const blocked: WorkView = {
      ...base,
      approvals: [],
      tasks: [],
      activities: [],
      progress: 0,
      run: {
        runId: "run-projection-refresh",
        status: "blocked",
        stage: "context-strategy",
        blockedReason: "strategy-failed",
        leaseGeneration: 4,
      },
    };
    const approval = {
      id: "approval-projection-refresh",
      title: "배포 계획 승인",
      description: "확정된 작업 2개를 실행합니다.",
      workId: blocked.id,
      revision: 1,
      status: "pending" as const,
    };
    const refreshed: WorkView = {
      ...blocked,
      approvals: [approval],
      tasks: base.tasks.slice(0, 2),
      activities: [
        {
          id: "approval-projection-refresh-activity",
          kind: "approval",
          time: "10:30",
          approvalId: approval.id,
          title: approval.title,
          description: approval.description,
        },
      ],
      progress: 50,
      run: {
        runId: "run-projection-refresh",
        status: "awaiting-approval",
        stage: "delivery",
        leaseGeneration: 5,
      },
    };
    let durable: ((event: unknown) => void) | undefined;
    const loadWork = vi.fn(async () => refreshed);
    render(
      <App
        service={service({
          initialSnapshot: { works: [blocked] },
          loadIndex: async () => [blocked],
          loadWork,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    expect(screen.getByRole("status", { name: "실행 상태" })).toHaveTextContent("차단됨");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toHaveTextContent("작업 0/0");
    await waitFor(() => expect(durable).toBeTypeOf("function"));

    act(() =>
      durable?.({
        sequence: 30,
        type: "run.suspended",
        resource: { type: "ApplicationRun", id: "run-projection-refresh", revision: 5 },
        payload: { stage: "delivery", workId: blocked.id },
      }),
    );

    await waitFor(() => expect(loadWork).toHaveBeenCalledWith(blocked.id));
    expect(screen.getByRole("status", { name: "실행 상태" })).toHaveTextContent("승인 대기");
    expect(screen.getByRole("complementary", { name: "Work 세부 정보" })).toHaveTextContent("작업 1/2");
    expect(screen.getByRole("button", { name: "배포 계획 승인 승인" })).toBeInTheDocument();
  });

  it("durable 갱신은 선택한 Work의 방만 다시 읽고 탭·오류·이전 성공 데이터를 보존한다", async () => {
    const user = userEvent.setup();
    const work = fixtureDataAdapter().works[0] as WorkView;
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
    };
    const quill: SpeakerView = {
      handle: "evidence-research",
      name: "Quill",
      initial: "Q",
      accentSlot: 2,
      role: "조사",
    };
    const auditMessage = (content: string): ActivityView => ({
      id: "audit-message",
      kind: "room",
      messageType: "evidence",
      time: "10:02",
      speaker: quill,
      content,
    });
    const auditRoom = (content: string): RoomView => ({
      roomId: "room-audit",
      name: "감사 방",
      status: "active",
      participants: [quill],
      lastMessageSequence: 1,
      budgets: [],
      sharedContexts: [],
      activities: [auditMessage(content)],
    });
    const coreRoom = (extraRooms: RoomView[]): RoomView => ({
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 1,
      budgets: [],
      sharedContexts: [],
      activities: extraRooms.map((candidate) => ({
        id: `roomref:${candidate.roomId}`,
        kind: "roomRef" as const,
        time: "10:01",
        roomId: candidate.roomId,
        name: candidate.name,
        participants: candidate.participants,
        messageCount: candidate.activities.length,
        lastLine: "감사 대화",
        waiting: false,
      })),
    });
    const newRoom: RoomView = {
      roomId: "room-new",
      name: "새 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 0,
      budgets: [],
      sharedContexts: [],
      activities: [],
    };
    let durable: ((event: unknown) => void) | undefined;
    let revision: "initial" | "refreshed" | "failed" | "removed" = "initial";
    const loadRooms = vi.fn(async () => {
      if (revision === "failed") throw new Error("협업방을 다시 읽지 못했습니다.");
      if (revision === "removed") return [auditRoom("갱신된 감사 대화"), newRoom];
      const audit = auditRoom(revision === "initial" ? "처음 감사 대화" : "갱신된 감사 대화");
      return [
        coreRoom([audit, ...(revision === "refreshed" ? [newRoom] : [])]),
        audit,
        ...(revision === "refreshed" ? [newRoom] : []),
      ];
    });
    const loadWork = vi.fn(async () => work);
    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadWork,
          loadRooms,
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "협업방 감사 방 열기" }));
    expect(screen.getByRole("region", { name: "협업방 감사 방" })).toHaveTextContent("처음 감사 대화");
    await waitFor(() => expect(durable).toBeTypeOf("function"));

    revision = "refreshed";
    act(() =>
      durable?.({
        sequence: 30,
        type: "collaboration.message-posted",
        resource: { type: "Work", id: "another-work" },
      }),
    );
    await act(async () => await new Promise((resolve) => setTimeout(resolve, 150)));
    expect(loadRooms).toHaveBeenCalledOnce();
    act(() =>
      durable?.({
        sequence: 31,
        type: "collaboration.message-posted",
        resource: { type: "Work", id: work.id },
      }),
    );
    await waitFor(() => expect(loadRooms).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("region", { name: "협업방 감사 방" })).toHaveTextContent("갱신된 감사 대화");
    expect(screen.getByRole("button", { name: /대표 방/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { current: true })).toHaveTextContent("감사 방");
    expect(screen.queryByRole("button", { name: /^새 방/u })).not.toBeInTheDocument();
    expect(loadWork).not.toHaveBeenCalled();

    revision = "failed";
    act(() =>
      durable?.({
        sequence: 32,
        type: "collaboration.message-posted",
        resource: { type: "Work", id: work.id },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("협업방을 다시 읽지 못했습니다.");
    expect(screen.getByRole("region", { name: "협업방 감사 방" })).toHaveTextContent("갱신된 감사 대화");

    revision = "removed";
    act(() =>
      durable?.({
        sequence: 33,
        type: "work.room.removed",
        resource: { type: "Work", id: work.id },
      }),
    );
    await waitFor(() => expect(loadRooms).toHaveBeenCalledTimes(4));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { current: true })).toHaveTextContent("감사 방");
    expect(screen.queryByRole("button", { name: /대표 방/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^새 방/u })).not.toBeInTheDocument();
  });

  it("방과 Work 활동을 ID 중복 없이 시간순으로 합치고 최종 응답 문법을 유지한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
    };
    const work: WorkView = {
      ...base,
      activities: [
        {
          id: "stage",
          kind: "event",
          semantic: "stage",
          time: "10:00",
          occurredAt: "2026-07-31T10:00:00.000Z",
          title: "실행 단계",
          detail: "준비",
          status: "진행",
        },
        {
          id: "duplicate",
          kind: "artifacts",
          time: "10:02",
          occurredAt: "2026-07-31T10:02:00.000Z",
          title: "산출물 활동",
          artifacts: [{ id: "artifact-1", name: "결과.csv", format: "CSV", size: "1 KB", createdAt: "10:02" }],
        },
        {
          id: "verification",
          kind: "event",
          semantic: "verification",
          time: "10:03",
          occurredAt: "2026-07-31T10:03:00.000Z",
          title: "검증 활동",
          detail: "통과",
          status: "완료",
        },
        {
          id: "record",
          kind: "event",
          semantic: "record",
          time: "10:04",
          occurredAt: "2026-07-31T10:04:00.000Z",
          title: "기록 활동",
          detail: "확정",
          status: "완료",
        },
        {
          id: "final",
          kind: "room",
          time: "10:05",
          occurredAt: "2026-07-31T10:05:00.000Z",
          messageType: "answer",
          speaker: atlas,
          content: "대표 최종 답변",
          final: true,
        },
      ],
    };
    const room: RoomView = {
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 2,
      budgets: [],
      sharedContexts: [],
      activities: [
        {
          id: "room-message",
          kind: "room",
          time: "23:59",
          occurredAt: "2026-07-31T10:01:00.000Z",
          messageType: "evidence",
          speaker: atlas,
          content: "방 대화",
        },
        {
          id: "duplicate",
          kind: "room",
          time: "10:02",
          occurredAt: "2026-07-31T10:02:30.000Z",
          messageType: "evidence",
          speaker: atlas,
          content: "중복 방 대화",
        },
      ],
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [room],
        })}
      />,
    );

    const activity = await screen.findByRole("region", { name: "협업방 대표 방" });
    for (const text of ["실행 단계", "방 대화", "산출물 활동", "검증 활동", "기록 활동", "대표 최종 답변"]) {
      expect(within(activity).getByText(text)).toBeInTheDocument();
    }
    expect(within(activity).queryByText("중복 방 대화")).not.toBeInTheDocument();
    expect(within(activity).getByText("최종 응답")).toHaveClass("bg-fg", "text-canvas");
    const text = activity.textContent ?? "";
    expect(text.indexOf("실행 단계")).toBeLessThan(text.indexOf("방 대화"));
    expect(text.indexOf("방 대화")).toBeLessThan(text.indexOf("산출물 활동"));
    expect(text.indexOf("산출물 활동")).toBeLessThan(text.indexOf("검증 활동"));
    expect(text.indexOf("검증 활동")).toBeLessThan(text.indexOf("기록 활동"));
    expect(text.indexOf("기록 활동")).toBeLessThan(text.indexOf("대표 최종 답변"));
  });

  it("같은 협업 메시지는 풍부한 방 활동 하나만 표시한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const messageId = "018f0f36-7b55-7d5c-9bb6-5f9979f52291";
    const occurredAt = "2026-07-31T10:01:00.000Z";
    const content = "근거를 확인했습니다.";
    const atlas: SpeakerView = {
      handle: "representative",
      name: "Atlas",
      initial: "A",
      accentSlot: 0,
      role: "조정",
    };
    const work: WorkView = {
      ...base,
      activities: [
        {
          id: `message:${messageId}`,
          kind: "message",
          time: occurredAt,
          occurredAt,
          author: "collaboration.message-posted",
          initials: "C",
          human: false,
          content,
        },
      ],
    };
    const room: RoomView = {
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [atlas],
      lastMessageSequence: 1,
      budgets: [],
      sharedContexts: [],
      activities: [
        {
          id: messageId,
          kind: "room",
          time: "10:01",
          occurredAt,
          messageType: "evidence",
          speaker: atlas,
          content,
        },
      ],
    };

    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [room],
        })}
      />,
    );

    const activity = await screen.findByRole("region", { name: "협업방 대표 방" });
    expect(within(activity).getAllByText(content)).toHaveLength(1);
    expect(within(activity).getByText("Atlas")).toBeInTheDocument();
    expect(activity).not.toHaveTextContent(messageId);
    expect(activity).not.toHaveTextContent(occurredAt);
    expect(activity).not.toHaveTextContent("collaboration.message-posted");
  });

  it("ISO 시각이 없는 legacy 활동은 ISO 활동과 섞어 비교하지 않고 뒤에서 결정적으로 정렬한다", async () => {
    const base = fixtureDataAdapter().works[0] as WorkView;
    const work: WorkView = {
      ...base,
      activities: [
        {
          id: "legacy-z",
          kind: "event",
          semantic: "stage",
          time: "00:01",
          title: "Legacy Z",
          detail: "",
          status: "",
        },
        {
          id: "legacy-a",
          kind: "event",
          semantic: "stage",
          time: "00:01",
          title: "Legacy A",
          detail: "",
          status: "",
        },
        {
          id: "canonical",
          kind: "event",
          semantic: "stage",
          time: "23:59",
          occurredAt: "2026-07-31T23:59:00.000Z",
          title: "Canonical",
          detail: "",
          status: "",
        },
      ],
    };
    const room: RoomView = {
      roomId: "room-core",
      name: "대표 방",
      status: "active",
      participants: [],
      lastMessageSequence: 0,
      budgets: [],
      sharedContexts: [],
      activities: [],
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [room],
        })}
      />,
    );

    const text = (await screen.findByRole("region", { name: "협업방 대표 방" })).textContent ?? "";
    expect(text.indexOf("Canonical")).toBeLessThan(text.indexOf("Legacy A"));
    expect(text.indexOf("Legacy A")).toBeLessThan(text.indexOf("Legacy Z"));
  });

  it("최초 방 조회 실패는 접근 가능한 오류이고 정상 무방 상태는 Work 활동이다", async () => {
    const work: WorkView = {
      ...(fixtureDataAdapter().works[0] as WorkView),
      activities: [
        {
          id: "agent-message",
          kind: "message",
          time: "09:58",
          author: "Atlas",
          initials: "A",
          human: false,
          content: "## 결과\n\n- 항목",
        },
        {
          id: "user-message",
          kind: "message",
          time: "09:59",
          author: "나",
          initials: "나",
          human: true,
          content: "## 요청\n\n- 그대로",
        },
        {
          id: "work-only",
          kind: "event",
          semantic: "stage",
          time: "10:00",
          title: "Work 전용 활동",
          detail: "",
          status: "",
        },
      ],
    };
    const expectFallbackMessages = () => {
      const activity = screen.getByRole("region", { name: "Work 활동" });
      expect(within(activity).getByRole("heading", { level: 2, name: "결과" })).toBeInTheDocument();
      expect(within(activity).getByText("항목").tagName).toBe("LI");
      expect(within(activity).queryByRole("heading", { name: "요청" })).toBeNull();
      const userMessage = within(activity).getByText(/## 요청/u);
      expect(userMessage).toHaveClass("whitespace-pre-wrap");
      expect(userMessage.textContent).toBe("## 요청\n\n- 그대로");
    };
    const failed = render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => {
            throw new Error("최초 협업방 조회 실패");
          },
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("최초 협업방 조회 실패");
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("Work 전용 활동");
    expectFallbackMessages();
    failed.unmount();

    render(
      <App
        service={service({
          initialSnapshot: { works: [work] },
          loadIndex: async () => [work],
          loadRooms: async () => [],
        })}
      />,
    );
    await waitFor(() => expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("Work 전용 활동"));
    expectFallbackMessages();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("이전 Work의 늦은 방 응답은 방이 없는 현재 Work를 덮지 않는다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const first = snapshot.works[0] as WorkView;
    const secondBase = snapshot.works[1] as WorkView;
    const second: WorkView = {
      ...secondBase,
      activities: [
        {
          id: "second-activity",
          kind: "event",
          semantic: "stage",
          time: "10:00",
          title: "현재 Work 활동",
          detail: "",
          status: "",
        },
      ],
    };
    const firstRooms = deferred<RoomView[]>();
    const staleRoom: RoomView = {
      roomId: "stale-room",
      name: "이전 Work 방",
      status: "active",
      participants: [],
      lastMessageSequence: 0,
      budgets: [],
      sharedContexts: [],
      activities: [{ id: "stale", kind: "roomStatus", time: "10:00", content: "오래된 방 응답" }],
    };
    render(
      <App
        service={service({
          initialSnapshot: { works: [first, second] },
          loadIndex: async () => [first, second],
          loadWork: async (workId) => (workId === second.id ? second : first),
          loadRooms: async (workId) => (workId === first.id ? await firstRooms.promise : []),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: new RegExp(second.title) }));
    expect(await screen.findByRole("region", { name: "Work 활동" })).toHaveTextContent("현재 Work 활동");
    firstRooms.resolve([staleRoom]);
    await Promise.resolve();
    expect(screen.getByRole("region", { name: "Work 활동" })).toHaveTextContent("현재 Work 활동");
    expect(screen.queryByText("오래된 방 응답")).not.toBeInTheDocument();
  });

  it("워크스페이스 없는 Work의 근거 빈 상태는 산출물 안내를 재사용하지 않는다", async () => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadWorkKnowledge: async (workId) => ({ workId, status: "not-applicable", references: [] }),
        })}
      />,
    );

    await user.click(await screen.findByRole("tab", { name: "근거" }));

    expect(await screen.findByText("이 Work는 워크스페이스 근거를 사용하지 않았습니다.")).toBeInTheDocument();
    expect(screen.getByText("워크스페이스를 선택한 새 Work에서 코드 근거를 사용할 수 있습니다.")).toBeInTheDocument();
    expect(screen.queryByText("실행이 산출물을 만들면 여기에 표시됩니다.")).not.toBeInTheDocument();
  });

  it("지식 workspace를 A에서 차단된 B로 바꾸는 첫 render부터 A graph·count·detail을 숨긴다", async () => {
    const user = userEvent.setup();
    const workspaceA = workspaceFixture("workspace-a", "A 폴더", "/tmp/a", "trusted", 1);
    const workspaceB = workspaceFixture("workspace-b", "B 폴더", "/tmp/b", "blocked", 1);
    const bIndex = deferred<KnowledgeIndexView>();
    const bGraph = deferred<KnowledgeGraphView>();
    let staleAtBRequest: { label: boolean; count: boolean; detail: boolean } | undefined;
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspaceA, workspaceB],
          loadKnowledgeIndex: async (workspaceId) => {
            if (workspaceId === workspaceB.workspaceId) {
              staleAtBRequest = {
                label: screen.queryAllByText("A 전용 노드").length > 0,
                count: screen.queryByText(/1개 · 0개 연결/u) !== null,
                detail: screen.queryByRole("complementary", { name: "노드 상세" }) !== null,
              };
              return await bIndex.promise;
            }
            return knowledgeIndexFixture(workspaceId);
          },
          loadKnowledgeGraph: async (workspaceId, lens) => {
            if (workspaceId === workspaceB.workspaceId) return await bGraph.promise;
            return knowledgeGraphFixture(lens, "a", "A 전용 노드");
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    expect(await screen.findByText("A 전용 노드")).toBeInTheDocument();
    for (const label of ["업무별", "문서별", "파일별", "심볼별", "산출물별", "담당별"]) {
      expect(screen.getByRole("button", { name: `${label} 지도` })).toBeInTheDocument();
    }
    const explorer = screen.getByText("노드 탐색").closest("details");
    if (!explorer) throw new Error("노드 탐색 구역이 없습니다");
    await user.click(within(explorer).getByText("노드 탐색"));
    await user.click(within(explorer).getByRole("button", { name: "A 전용 노드 선택" }));
    expect(screen.getByRole("complementary", { name: "노드 상세" })).toHaveTextContent("A 전용 노드");

    await user.selectOptions(screen.getByLabelText("워크스페이스"), workspaceB.workspaceId);
    expect(staleAtBRequest).toEqual({ label: false, count: false, detail: false });
    expect(screen.queryByText("A 전용 노드")).not.toBeInTheDocument();
    expect(screen.queryByText(/1개 · 0개 연결/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "노드 상세" })).not.toBeInTheDocument();

    await act(async () => {
      bIndex.reject(new Error("B 폴더는 차단되었습니다"));
      bGraph.resolve(knowledgeGraphFixture("work", "b", "B 비공개 노드"));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("B 폴더는 차단되었습니다");
    expect(screen.queryByText("A 전용 노드")).not.toBeInTheDocument();
    expect(screen.queryByText("B 비공개 노드")).not.toBeInTheDocument();
  });

  it("느린 A workspace 응답이 빠른 B 선택 뒤에 도착해도 B graph를 덮지 않는다", async () => {
    const user = userEvent.setup();
    const workspaceA = workspaceFixture("workspace-a", "A 폴더", "/tmp/a", "trusted", 1);
    const workspaceB = workspaceFixture("workspace-b", "B 폴더", "/tmp/b", "trusted", 1);
    const aIndex = deferred<KnowledgeIndexView>();
    const aGraph = deferred<KnowledgeGraphView>();
    const loadKnowledgeGraph = vi.fn(async (workspaceId: string, lens: KnowledgeNodeKind) =>
      workspaceId === workspaceA.workspaceId ? await aGraph.promise : knowledgeGraphFixture(lens, "b", "B 전용 노드"),
    );
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspaceA, workspaceB],
          loadKnowledgeIndex: async (workspaceId) =>
            workspaceId === workspaceA.workspaceId ? await aIndex.promise : knowledgeIndexFixture(workspaceId),
          loadKnowledgeGraph,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    await waitFor(() => expect(loadKnowledgeGraph).toHaveBeenCalledWith(workspaceA.workspaceId, "work"));
    await user.selectOptions(screen.getByLabelText("워크스페이스"), workspaceB.workspaceId);
    expect(await screen.findByText("B 전용 노드")).toBeInTheDocument();

    await act(async () => {
      aIndex.reject(new Error("A 지연 오류"));
      aGraph.resolve(knowledgeGraphFixture("work", "a", "A 지연 노드"));
    });
    expect(screen.getByText("B 전용 노드")).toBeInTheDocument();
    expect(screen.queryByText("A 지연 노드")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("느린 이전 lens가 새 lens보다 늦게 끝나도 새 graph를 덮지 않는다", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture("workspace-a", "A 폴더", "/tmp/a", "trusted", 1);
    const fileGraph = deferred<KnowledgeGraphView>();
    let staleAtFileRequest: { label: boolean; count: boolean; detail: boolean } | undefined;
    const loadKnowledgeGraph = vi.fn(async (_workspaceId: string, lens: KnowledgeNodeKind) => {
      if (lens === "file") {
        staleAtFileRequest = {
          label: screen.queryAllByText("이전 업무 노드").length > 0,
          count: screen.queryByText(/1개 · 0개 연결/u) !== null,
          detail: screen.queryByRole("complementary", { name: "노드 상세" }) !== null,
        };
        return await fileGraph.promise;
      }
      if (lens === "symbol") return knowledgeGraphFixture(lens, "new", "새 심볼 노드");
      return knowledgeGraphFixture(lens, "old", "이전 업무 노드");
    });
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspace],
          loadKnowledgeIndex: async () => knowledgeIndexFixture(workspace.workspaceId),
          loadKnowledgeGraph,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    expect(await screen.findByText("이전 업무 노드")).toBeInTheDocument();
    const explorer = screen.getByText("노드 탐색").closest("details");
    if (!explorer) throw new Error("노드 탐색 구역이 없습니다");
    await user.click(within(explorer).getByText("노드 탐색"));
    await user.click(within(explorer).getByRole("button", { name: "이전 업무 노드 선택" }));
    expect(screen.getByRole("complementary", { name: "노드 상세" })).toHaveTextContent("이전 업무 노드");
    await user.click(screen.getByRole("button", { name: "파일별 지도" }));
    await waitFor(() => expect(loadKnowledgeGraph).toHaveBeenCalledWith(workspace.workspaceId, "file"));
    expect(staleAtFileRequest).toEqual({ label: false, count: false, detail: false });
    expect(screen.queryByText("이전 업무 노드")).not.toBeInTheDocument();
    expect(screen.queryByText(/1개 · 0개 연결/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "노드 상세" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "심볼별 지도" }));
    expect(await screen.findByText("새 심볼 노드")).toBeInTheDocument();

    await act(async () => {
      fileGraph.resolve(knowledgeGraphFixture("file", "late", "늦은 파일 노드"));
    });
    expect(screen.getByText("새 심볼 노드")).toBeInTheDocument();
    expect(screen.queryByText("늦은 파일 노드")).not.toBeInTheDocument();
  });

  it("노드 탐색은 Tab·Enter로 열고 선택하여 pointer와 같은 상세·links·선택 상태를 제공한다", async () => {
    const user = userEvent.setup();
    const workspace = workspaceFixture("workspace-keyboard", "키보드 폴더", "/tmp/keyboard", "trusted", 1);
    const alpha = {
      nodeId: "work:alpha",
      kind: "work" as const,
      label: "Alpha 노드",
      detail: "alpha detail",
    };
    const zeta = {
      nodeId: "work:zeta",
      kind: "work" as const,
      label: "Zeta 노드",
      detail: "zeta detail",
    };
    const graph: KnowledgeGraphView = { lens: "work", nodes: [zeta, alpha], edges: [] };
    const loadKnowledgeLinks = vi.fn(async (_workspaceId: string, nodeId: string) =>
      nodeId === alpha.nodeId ? [{ node: zeta, kind: "documents" as const, direction: "outgoing" as const }] : [],
    );
    render(
      <App
        service={service({
          loadWorkspaces: async () => [workspace],
          loadKnowledgeIndex: async () => knowledgeIndexFixture(workspace.workspaceId),
          loadKnowledgeGraph: async () => graph,
          loadKnowledgeLinks,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "지식" }));
    const details = (await screen.findByText("노드 탐색")).closest("details");
    if (!details) throw new Error("노드 탐색 구역이 없습니다");
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByRole("button", { name: "Alpha 노드 선택" })).not.toBeVisible();

    screen.getByRole("button", { name: "담당별 지도" }).focus();
    await user.tab();
    expect(details.querySelector("summary")).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(details).toHaveAttribute("open");

    await user.tab();
    const alphaButton = within(details).getByRole("button", { name: "Alpha 노드 선택" });
    const zetaButton = within(details).getByRole("button", { name: "Zeta 노드 선택" });
    expect(alphaButton).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(alphaButton).toHaveAttribute("aria-pressed", "true");
    expect(zetaButton).toHaveAttribute("aria-pressed", "false");
    const inspector = await screen.findByRole("complementary", { name: "노드 상세" });
    expect(within(inspector).getByRole("heading", { name: "Alpha 노드" })).toBeInTheDocument();
    await waitFor(() => expect(loadKnowledgeLinks).toHaveBeenCalledWith(workspace.workspaceId, alpha.nodeId));
    expect(within(inspector).getByRole("button", { name: "Zeta 노드(으)로 이동" })).toBeInTheDocument();

    await user.click(zetaButton);
    expect(alphaButton).toHaveAttribute("aria-pressed", "false");
    expect(zetaButton).toHaveAttribute("aria-pressed", "true");
    expect(within(inspector).getByRole("heading", { name: "Zeta 노드" })).toBeInTheDocument();
    await waitFor(() => expect(loadKnowledgeLinks).toHaveBeenCalledWith(workspace.workspaceId, zeta.nodeId));
    expect(within(inspector).getByText("이어진 것이 없습니다.")).toBeInTheDocument();
  });

  it("설정은 실제 읽기 전용 상태만 조회하고 자격증명 값을 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const loadSettings = vi.fn(async () => ({
      catalog: [],
      credentials: [{ value: "절대-표시되면-안됨" }],
      routes: [{ id: "route-1" }],
      providers: [{ id: "provider-1" }],
      accounts: [{ id: "account-1" }],
      quota: [],
      policy: [],
    }));
    render(<App service={service({ loadSettings })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    await screen.findByRole("main", { name: "설정" });
    // 설정은 탭도 목록도 아닌 한 문서입니다. 세 구역이 함께 보입니다.
    for (const title of ["권한", "자가개선"]) {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    }
    // 프로바이더와 계정은 프로바이더 표면이 소유합니다.
    expect(screen.queryByText(/Provider 연결/)).not.toBeInTheDocument();
    expect(screen.queryByText("구독 계정")).not.toBeInTheDocument();
    // 설정 표면 진입이 실제 조회를 유발했는지만 봅니다.
    expect(loadSettings).toHaveBeenCalled();
    expect(screen.queryByText("절대-표시되면-안됨")).not.toBeInTheDocument();
  });

  it("Provider 인증 연결을 순서대로 저장하고 secret을 다시 표시하지 않는다", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    const loadSettings = vi.fn(async () => ({
      catalog: {
        endpoints: [
          { endpointId: "endpoint-1", providerId: "openai", name: "api", baseUrl: "https://api.openai.com/v1" },
        ],
      },
      credentials: [],
      routes: [],
      providers: [],
      accounts: [],
      quota: [],
      policy: [],
    }));
    const registerProvider = vi.fn(async () => {
      calls.push("provider");
    });
    const registerEndpoint = vi.fn(async () => {
      calls.push("endpoint");
    });
    const addCredential = vi.fn(async () => {
      calls.push("credential");
    });
    render(<App service={service({ loadSettings, registerProvider, registerEndpoint, addCredential })} />);

    await user.click(screen.getByRole("button", { name: "프로바이더" }));
    await user.click(await screen.findByRole("button", { name: "프로바이더 추가" }));
    const form = await screen.findByRole("form", { name: "프로바이더 추가" });
    // 사람이 대는 것은 넷뿐이고 내부 id·endpoint 이름·자격 종류는 도출합니다.
    await user.type(within(form).getByRole("textbox", { name: "이름" }), "OpenAI");
    await user.type(within(form).getByRole("textbox", { name: "Base URL" }), "https://api.openai.com/v1");
    const secret = within(form).getByLabelText(/키/);
    await user.type(secret, "never-render-this");
    await user.click(within(form).getByRole("button", { name: "추가" }));

    expect(await screen.findByText("프로바이더를 추가했습니다.")).toBeInTheDocument();
    expect(calls).toEqual(["provider", "endpoint", "credential"]);
    expect(addCredential).toHaveBeenCalledWith(
      expect.objectContaining({ endpointId: "endpoint-1", secret: "never-render-this", priority: 0, weight: 100 }),
    );
    expect(secret).toHaveValue("");
    expect(screen.queryByText("never-render-this")).not.toBeInTheDocument();
  });

  it.each([
    ["활성", [{ status: "active" }], "구독 계정으로 연결됨"],
    ["비활성", [{ status: "expired" }], "계정 확인이 필요합니다"],
    ["없음", [], "로그인이 필요합니다"],
  ] as const)("구독 커넥터의 %s OAuth 계정을 인증 상태로 표시한다", async (_case, rows, expected) => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadSettings: async () => ({
            catalog: {
              providers: [
                {
                  providerId: "openai-codex",
                  displayName: "OpenAI Codex",
                  adapterKind: "subscription-connector",
                  enabled: true,
                },
              ],
              endpoints: [
                {
                  endpointId: "codex-app-server",
                  providerId: "openai-codex",
                  name: "Codex app server",
                  baseUrl: "massion-connector:///openai-codex/codex-app-server",
                  local: false,
                },
              ],
              models: [],
              credentials: [],
            },
            credentials: [],
            routes: [],
            providers: [],
            accounts: rows.map((account) => ({
              accountId: "account-codex",
              providerId: "openai-codex",
              alias: "Codex",
              status: account.status,
              billingKind: "consumer-subscription",
            })),
            quota: [],
            policy: [],
          }),
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "프로바이더" }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.queryByText("등록되지 않았습니다")).not.toBeInTheDocument();
  });

  it.each([
    ["첫 로그인", [], "Codex 로그인", false, "OpenAI Codex"],
    ["기존 계정 재연결", [{ status: "offline" }], "다시 연결", false, "Codex"],
    ["비활성 계정 옆 새 계정", [{ status: "offline" }], "새 계정 추가", true, "OpenAI Codex"],
    ["활성 계정 옆 추가", [{ status: "active" }], "계정 추가", true, "OpenAI Codex"],
  ] as const)(
    "구독 커넥터의 %s 동작을 실제 로그인 워크플로에 연결한다",
    async (_case, rows, label, newAccount, alias) => {
      const user = userEvent.setup();
      const loginSubscription = vi.fn(async () => undefined);
      const loadSettings = vi.fn(async () => ({
        catalog: {
          providers: [
            {
              providerId: "openai-codex",
              displayName: "OpenAI Codex",
              adapterKind: "subscription-connector",
              enabled: true,
            },
          ],
          endpoints: [],
          models: [],
          credentials: [],
        },
        credentials: [],
        routes: [],
        providers: [],
        accounts: rows.map((account) => ({
          accountId: "account-codex",
          providerId: "openai-codex",
          alias: "Codex",
          status: account.status,
          billingKind: "consumer-subscription",
        })),
        quota: [],
        policy: [],
      }));
      render(<App service={service({ loadSettings, loginSubscription })} />);

      await user.click(screen.getByRole("button", { name: "프로바이더" }));
      await user.click(await screen.findByRole("button", { name: label }));

      expect(loginSubscription).toHaveBeenCalledWith({
        providerId: "openai-codex",
        alias,
        newAccount,
      });
      expect(loadSettings).toHaveBeenCalledTimes(2);
      expect(await screen.findByText("Codex 계정 연결을 완료했습니다.")).toBeInTheDocument();
    },
  );

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
    const installRegistry = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "awaiting-approval", approvalId: "approval-install-1" })
      .mockResolvedValueOnce({ outcome: "succeeded", installationId: "installation-1" });
    const approval = {
      id: "approval-install-1",
      title: "Calendar 설치",
      description: "설치 승인",
      revision: 1,
      status: "pending",
    };
    const decideApproval = vi.fn(async () => undefined);
    render(
      <App
        service={service({
          decideApproval,
          installRegistry,
          loadExtensions,
          loadPendingApprovals: async () => [approval],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "확장" }));
    await user.click(await screen.findByRole("button", { name: "설치" }));
    const initialRequest = installRegistry.mock.calls[0]?.[0];
    const identity = installRegistry.mock.calls[0]?.[1];

    await user.click(screen.getByRole("button", { name: /수신함/ }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    expect(within(panel).queryByRole("button", { name: /승인$/ })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "승인 검토 열기: Calendar 설치" }));
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const extension = await screen.findByRole("main", { name: "확장" });
    await user.click(within(extension).getByRole("button", { name: "Calendar 설치 승인" }));
    expect(decideApproval).toHaveBeenCalledWith(approval, "approve", "데스크톱 확장에서 승인");
    await waitFor(() => expect(installRegistry).toHaveBeenCalledTimes(2));
    expect(installRegistry).toHaveBeenNthCalledWith(
      2,
      { ...initialRequest, installApprovalId: "approval-install-1" },
      identity,
    );
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

  it("같은 차단 실행을 Home·Inbox·Work에서 같은 상태로 표시하고 폴더 신뢰는 Settings 해결 지점으로 이동한다", async () => {
    const user = userEvent.setup();
    const resumeRun = vi.fn(async () => undefined);
    render(<App service={service({ resumeRun })} />);

    await user.click(screen.getByRole("button", { name: "홈" }));
    const home = await screen.findByRole("main", { name: "홈" });
    const homeBlocked = within(home).getByRole("button", { name: /파트너 계약서 검토/u });
    expect(within(homeBlocked).getByText("차단됨")).toHaveClass("text-halt");

    await user.click(await screen.findByRole("button", { name: /수신함, 미해결/ }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const approvalSource = within(panel).getByRole("button", { name: "승인 검토 열기: CRM 고객 데이터 읽기" });
    const blockedSource = within(panel).getByRole("button", { name: "업무로 이동: 파트너 계약서 검토" });

    expect(approvalSource).toHaveTextContent("CRM 고객 데이터 읽기승인 대기");
    expect(within(blockedSource).getByText("차단됨")).toHaveClass("text-halt");
    expect(approvalSource.lastElementChild?.tagName).toBe("svg");
    expect(blockedSource.lastElementChild?.tagName).toBe("svg");
    expect(approvalSource.parentElement?.tagName).toBe("H3");
    expect(blockedSource.parentElement?.tagName).toBe("H3");
    expect(within(panel).queryByRole("button", { name: "CRM 고객 데이터 읽기 승인" })).not.toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "CRM 고객 데이터 읽기 거절" })).not.toBeInTheDocument();
    expect(within(panel).queryByText("업무 열기")).not.toBeInTheDocument();

    await user.click(blockedSource);
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const work = screen.getByRole("main", { name: "파트너 계약서 검토" });
    const workList = screen.getByRole("region", { name: "Work 목록" });
    const workRow = within(workList).getByRole("button", { name: /파트너 계약서 검토/u });
    const runStatus = within(work).getByRole("status", { name: "실행 상태" });
    expect(within(workRow).getByText("차단됨")).toHaveClass("text-halt");
    expect(within(runStatus).getByText("차단됨")).toHaveClass("text-halt");
    expect(runStatus).not.toHaveTextContent(/막힘|중단됨|에서 멈춤/u);
    await user.click(within(runStatus).getByRole("button", { name: "폴더 신뢰" }));
    const settings = await screen.findByRole("main", { name: "설정" });
    const workspaceTrust = within(settings).getByRole("region", { name: "작업공간 신뢰" });
    expect(workspaceTrust).toHaveFocus();
    expect(within(workspaceTrust).getByRole("button", { name: "ops-runbook 신뢰" })).toBeInTheDocument();
    expect(resumeRun).not.toHaveBeenCalled();
  });

  it("승인 대기 실행은 Home·Inbox·Work에서 gate 상태로 일치한다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const awaiting: WorkView = {
      ...base,
      run: { runId: "run-awaiting-status", status: "awaiting-approval", stage: "evidence", leaseGeneration: 1 },
    };
    const ready: WorkView = {
      ...base,
      approvals: [],
      id: "work-ready-status",
      title: "준비된 업무",
      run: { runId: "run-ready-status", status: "ready", stage: "intake", leaseGeneration: 1 },
    };
    const running: WorkView = {
      ...base,
      approvals: [],
      id: "work-running-status",
      title: "실행 중인 업무",
      run: { runId: "run-running-status", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const excluded = (["blocked", "cancelled", "completed", "failed"] as const).map((status): WorkView => ({
      ...base,
      approvals: [],
      id: `work-${status}-status`,
      title: `${status} 실행 업무`,
      run: { runId: `run-${status}-status`, status, stage: "delivery", leaseGeneration: 1 },
    }));
    const withoutRun: WorkView = { ...base, approvals: [], id: "work-without-run", title: "실행 없는 업무" };
    const works = [awaiting, ready, running, withoutRun, ...excluded];
    render(
      <App
        service={service({
          initialSnapshot: { works },
          loadIndex: async () => works,
          loadWork: async () => awaiting,
        })}
      />,
    );

    const workList = screen.getByRole("region", { name: "Work 목록" });
    expect(within(workList).getByText("승인 대기")).toHaveClass("text-gate");

    await user.click(screen.getByRole("button", { name: "홈" }));
    const home = await screen.findByRole("main", { name: "홈" });
    const waiting = within(home).getByRole("region", { name: "나를 기다리는 것" });
    const active = within(home).getByRole("region", { name: "지금 도는 것" });
    expect(within(waiting).getByText("CRM 고객 데이터 읽기")).toBeInTheDocument();
    expect(within(waiting).getByText("승인 대기")).toHaveClass("text-gate");
    expect(within(active).getByRole("button", { name: /준비된 업무/u })).toBeInTheDocument();
    expect(within(active).getByRole("button", { name: /실행 중인 업무/u })).toBeInTheDocument();
    for (const title of [awaiting.title, withoutRun.title, ...excluded.map((work) => work.title)]) {
      expect(within(active).queryByRole("button", { name: new RegExp(title, "u") })).not.toBeInTheDocument();
    }

    await user.click(await screen.findByRole("button", { name: /수신함, 미해결/u }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const approvalSource = within(panel).getByRole("button", { name: "승인 검토 열기: CRM 고객 데이터 읽기" });
    expect(within(approvalSource).getByText("승인 대기")).toHaveClass("text-gate");

    await user.click(approvalSource);
    const work = screen.getByRole("main", { name: awaiting.title });
    const runStatus = within(work).getByRole("status", { name: "실행 상태" });
    expect(within(runStatus).getByText("승인 대기")).toHaveClass("text-gate");
    expect(within(runStatus).queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
  });

  it("빈 Inbox는 차단 상태의 정본 용어를 사용한다", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureDesktopService();
    const growth = await fixture.loadGrowth();
    render(
      <App
        service={{
          ...fixture,
          initialSnapshot: { works: [] },
          loadGrowth: async () => ({ ...growth, suggestions: [] }),
          loadIndex: async () => [],
          loadPendingApprovals: async () => [],
        }}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "수신함" }));
    const inbox = await screen.findByRole("dialog", { name: "수신함" });
    expect(within(inbox).getByText("지금 사람을 기다리거나 차단된 것이 없습니다.")).toBeInTheDocument();
    expect(within(inbox).queryByText(/막힌 것이/u)).not.toBeInTheDocument();
  });

  it("취소와 실패 상태는 Work 목록과 상세에서 정본 용어와 색을 유지한다", async () => {
    const user = userEvent.setup();
    const base = fixtureDataAdapter().works[0] as WorkView;
    const cancelled: WorkView = { ...base, id: "work-cancelled", title: "취소한 업무", status: "cancelled" };
    const failed: WorkView = { ...base, id: "work-failed", title: "실패한 업무", status: "failed" };
    render(
      <App
        service={service({
          initialSnapshot: { works: [cancelled, failed] },
          loadIndex: async () => [cancelled, failed],
          loadWork: async (workId) => (workId === failed.id ? failed : cancelled),
        })}
      />,
    );

    const list = screen.getByRole("region", { name: "Work 목록" });
    await user.click(within(list).getByRole("tab", { name: "완료" }));
    const cancelledRow = await within(list).findByRole("button", { name: /취소한 업무/u });
    expect(within(cancelledRow).getByText("취소됨")).toHaveClass("text-muted");
    expect(screen.getByRole("heading", { name: cancelled.title }).nextElementSibling).toHaveClass("text-muted");

    const failedRow = within(list).getByRole("button", { name: /실패한 업무/u });
    expect(within(failedRow).getByText("실패")).toHaveClass("text-danger");
    await user.click(failedRow);
    expect(await screen.findByRole("main", { name: failed.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: failed.title }).nextElementSibling).toHaveClass("text-danger");
  });

  it("수신함은 검토 대기 개선을 집계하고 해당 개선 상세로 이동한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(await screen.findByRole("button", { name: "수신함, 미해결 4개" }));
    const panel = await screen.findByRole("dialog", { name: "수신함" });
    const improvement = within(panel).getByRole("button", {
      name: "개선 검토 열기: 분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다.",
    });
    expect(improvement).toHaveTextContent("검토 대기");

    await user.click(improvement);
    expect(screen.queryByRole("dialog", { name: "수신함" })).not.toBeInTheDocument();
    const growth = await screen.findByRole("main", { name: "개선" });
    expect(
      within(growth).getByRole("heading", { name: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다." }),
    ).toBeInTheDocument();
    expect(
      within(growth).getByRole("button", { name: "분기 비교 요청에서 코호트 정의를 먼저 확인하게 합니다. 승인" }),
    ).toBeEnabled();
  });

  it("권한은 설정에서 실제 서비스 조회를 사용한다", async () => {
    const user = userEvent.setup();
    const loadPendingApprovals = vi.fn(createFixtureDesktopService().loadPendingApprovals);
    const loadAutonomy = vi.fn(createFixtureDesktopService().loadAutonomy);
    render(<App service={service({ loadPendingApprovals, loadAutonomy })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    expect(await screen.findByRole("region", { name: "권한과 자가개선" })).toBeInTheDocument();
    await waitFor(() => {
      expect(loadPendingApprovals).toHaveBeenCalledOnce();
      expect(loadAutonomy).toHaveBeenCalledOnce();
    });
  });

  it("Settings의 자가개선 반영 방식은 실제 Growth 설정으로 저장한다", async () => {
    const user = userEvent.setup();
    const loadAutonomy = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "automatic",
        revision: 1,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
        growthMode: "review",
        growthReflectionEnabled: true,
        growthConfigurationVersion: 3,
      })
      .mockResolvedValueOnce({
        mode: "automatic",
        revision: 1,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
        growthMode: "auto",
        growthReflectionEnabled: true,
        growthConfigurationVersion: 4,
      });
    const configureGrowth = vi.fn(async () => undefined);
    render(<App service={service({ loadAutonomy, configureGrowth })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const settings = await screen.findByRole("region", { name: "권한과 자가개선" });
    const growth = within(settings).getByRole("region", { name: "자가개선" });
    expect(within(growth).getByRole("button", { name: "수동" })).toHaveAttribute("aria-pressed", "true");

    await user.click(within(growth).getByRole("button", { name: "자동" }));

    await waitFor(() =>
      expect(configureGrowth).toHaveBeenCalledWith({
        reflectionEnabled: true,
        adoptionMode: "auto",
        expectedVersion: 3,
      }),
    );
    await waitFor(() => expect(loadAutonomy).toHaveBeenCalledTimes(2));
    expect(within(growth).getByRole("button", { name: "자동" })).toHaveAttribute("aria-pressed", "true");
  });

  it("자가개선 저장 후 재조회 실패는 저장 성공과 조회 실패를 구분한다", async () => {
    const user = userEvent.setup();
    const loadAutonomy = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "automatic",
        revision: 1,
        runtimePermissionStatus: "governed",
        emergencyStopActive: false,
        growthMode: "review",
        growthReflectionEnabled: true,
        growthConfigurationVersion: 3,
      })
      .mockRejectedValueOnce(new Error("최신 설정 조회 실패"));
    render(<App service={service({ loadAutonomy, configureGrowth: vi.fn(async () => undefined) })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const growth = within(await screen.findByRole("region", { name: "권한과 자가개선" })).getByRole("region", {
      name: "자가개선",
    });
    await user.click(within(growth).getByRole("button", { name: "자동" }));

    expect(await within(growth).findByRole("alert")).toHaveTextContent(
      "자가개선 설정은 저장됐지만 최신 상태를 불러오지 못했습니다. 최신 설정 조회 실패",
    );
  });

  it("Settings의 전체 권한은 확인 뒤 실제 지속 권한 명령으로 저장한다", async () => {
    const user = userEvent.setup();
    const setAutonomy = vi.fn(createFixtureDesktopService().setAutonomy);
    render(<App service={service({ setAutonomy })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const settings = await screen.findByRole("region", { name: "권한과 자가개선" });
    expect(within(settings).queryByText("바이패스")).not.toBeInTheDocument();
    await user.click(within(settings).getByRole("button", { name: "전체 권한" }));
    await user.click(within(settings).getByRole("button", { name: "승인" }));

    await waitFor(() => expect(setAutonomy).toHaveBeenCalledWith("full-access", 0));
    expect(screen.getByText("권한을 저장했습니다.")).toBeInTheDocument();
  });

  it("설정은 작업공간의 신뢰 상태와 개정을 표시하고 신뢰 명령의 실제 반환 행만 갱신한다", async () => {
    const user = userEvent.setup();
    const pending = workspaceFixture("workspace-pending", "검토 폴더", "/tmp/pending", "pending", 1);
    const blocked = workspaceFixture("workspace-blocked", "차단 폴더", "/tmp/blocked", "blocked", 2);
    const trusted = workspaceFixture("workspace-trusted", "신뢰 폴더", "/tmp/trusted", "trusted", 3);
    const response = deferred<DesktopWorkspaceView>();
    const loadWorkspaces = vi.fn(async () => [pending, blocked, trusted]);
    const decideWorkspaceTrust = vi.fn(async () => await response.promise);
    render(<App service={service({ loadWorkspaces, decideWorkspaceTrust })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "작업공간 신뢰" });
    for (const title of ["권한", "자가개선", "작업공간 신뢰"]) {
      expect(screen.getByRole("heading", { name: title, level: 2 })).toBeInTheDocument();
    }
    const pendingRow = within(section).getByRole("row", { name: /검토 폴더/u });
    expect(pendingRow).toHaveTextContent("/tmp/pending");
    expect(pendingRow).toHaveTextContent("신뢰 대기 (pending)");
    expect(pendingRow).toHaveTextContent("개정 1");
    expect(within(section).getByRole("row", { name: /차단 폴더/u })).toHaveTextContent("차단됨 (blocked)");
    expect(within(section).getByRole("row", { name: /신뢰 폴더/u })).toHaveTextContent("신뢰됨 (trusted)");

    const trustButton = within(pendingRow).getByRole("button", { name: "검토 폴더 신뢰" });
    await user.click(trustButton);
    await user.click(trustButton);
    expect(decideWorkspaceTrust).toHaveBeenCalledOnce();
    expect(decideWorkspaceTrust).toHaveBeenCalledWith(pending, "trusted");
    expect(trustButton).toBeDisabled();

    response.resolve({ ...pending, name: "서버가 돌려준 폴더", trust: "trusted", revision: 9 });
    const updatedRow = await within(section).findByRole("row", { name: /서버가 돌려준 폴더/u });
    expect(updatedRow).toHaveTextContent("신뢰됨 (trusted)");
    expect(updatedRow).toHaveTextContent("개정 9");
    expect(within(section).getByRole("row", { name: /차단 폴더/u })).toHaveTextContent("개정 2");
    expect(loadWorkspaces).toHaveBeenCalledOnce();
  });

  it("신뢰된 작업공간은 확인 뒤에만 회수하고 revision 오류를 해당 설정 구역에 표시한다", async () => {
    const user = userEvent.setup();
    const trusted = workspaceFixture("workspace-trusted", "신뢰 폴더", "/tmp/trusted", "trusted", 3);
    const decideWorkspaceTrust = vi.fn(async () => {
      throw new Error("workspace revision이 일치하지 않습니다");
    });
    render(<App service={service({ loadWorkspaces: async () => [trusted], decideWorkspaceTrust })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "작업공간 신뢰" });
    await user.click(within(section).getByRole("button", { name: "신뢰 폴더 신뢰 회수" }));
    expect(decideWorkspaceTrust).not.toHaveBeenCalled();

    const confirmation = await screen.findByRole("alertdialog", { name: "신뢰 회수 확인" });
    expect(confirmation).toHaveTextContent("/tmp/trusted");
    await user.click(within(confirmation).getByRole("button", { name: "신뢰 폴더 회수하고 차단" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent("workspace revision이 일치하지 않습니다");
    expect(decideWorkspaceTrust).toHaveBeenCalledWith(trusted, "blocked");
    const unchangedRow = within(section).getByRole("row", { name: /신뢰 폴더/u });
    expect(unchangedRow).toHaveTextContent("신뢰됨 (trusted)");
    expect(unchangedRow).toHaveTextContent("개정 3");
  });

  it("신뢰 명령의 늦은 다른 작업공간 응답은 어느 행에도 주입하지 않는다", async () => {
    const user = userEvent.setup();
    const current = workspaceFixture("workspace-current", "현재 폴더", "/tmp/current", "pending", 4);
    const foreign = workspaceFixture("workspace-foreign", "다른 폴더", "/tmp/foreign", "trusted", 99);
    const decideWorkspaceTrust = vi.fn(async () => foreign);
    render(<App service={service({ loadWorkspaces: async () => [current], decideWorkspaceTrust })} />);

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "작업공간 신뢰" });
    await user.click(within(section).getByRole("button", { name: "현재 폴더 신뢰" }));

    expect(await within(section).findByRole("alert")).toHaveTextContent(
      "작업공간 신뢰 응답의 식별자가 요청과 일치하지 않습니다.",
    );
    const unchangedRow = within(section).getByRole("row", { name: /현재 폴더/u });
    expect(unchangedRow).toHaveTextContent("신뢰 대기 (pending)");
    expect(unchangedRow).toHaveTextContent("개정 4");
    expect(within(section).queryByText("다른 폴더")).not.toBeInTheDocument();
    expect(decideWorkspaceTrust).toHaveBeenCalledWith(current, "trusted");
  });

  it("설정과 권한 조회 실패가 작업공간 신뢰 목록을 가리지 않는다", async () => {
    const user = userEvent.setup();
    const pending = workspaceFixture("workspace-pending", "검토 폴더", "/tmp/pending", "pending", 1);
    render(
      <App
        service={service({
          loadSettings: async () => {
            throw new Error("설정 조회 실패");
          },
          loadAutonomy: async () => {
            throw new Error("권한 조회 실패");
          },
          loadWorkspaces: async () => [pending],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "설정" }));
    const section = await screen.findByRole("region", { name: "작업공간 신뢰" });
    expect(within(section).getByRole("row", { name: /검토 폴더/u })).toBeInTheDocument();
    expect(screen.getByText("설정 조회 실패")).toBeInTheDocument();
    expect(screen.getByText("권한 조회 실패")).toBeInTheDocument();
  });

  it("작업공간 목록 조회 실패가 권한 설정을 가리지 않는다", async () => {
    const user = userEvent.setup();
    render(
      <App
        service={service({
          loadWorkspaces: async () => {
            throw new Error("작업공간 목록 조회 실패");
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "설정" }));
    const permissions = await screen.findByRole("region", { name: "권한" });
    expect(within(permissions).getByRole("button", { name: "전체 권한" })).toBeInTheDocument();
    const workspaces = screen.getByRole("region", { name: "작업공간 신뢰" });
    expect(within(workspaces).getByRole("alert")).toHaveTextContent("작업공간 목록 조회 실패");
  });

  it("성장 화면은 개인 기억과 승인 근거를 함께 표시한다", async () => {
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
          revision: 3,
          entries: [
            {
              key: "verification-required",
              kind: "procedure" as const,
              value: "검증 근거를 남긴다",
              authority: "explicit" as const,
            },
          ],
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
    expect(screen.getByText("검증 근거를 남긴다")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "앞으로 사용하지 않음" })).toBeInTheDocument();
    // 판단에 필요한 증거가 순서대로 있어야 합니다. 요약만 보고 채택하면 승인 버튼 하나와 같습니다.
    expect(screen.getByRole("region", { name: "왜" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "승인하면" })).toBeInTheDocument();
    // 어떤 작업에서 올라온 제안인지 추적할 수 있어야 합니다.
    expect(screen.getByRole("region", { name: "어디서 나왔나" })).toBeInTheDocument();
    expect(screen.getByText("개선 확인")).toBeInTheDocument();
    expect(loadGrowth).toHaveBeenCalledOnce();

    // 채택 command가 아직 없으므로 제안 판단은 여전히 실행하지 않습니다.
    // 문구가 아니라 disabled로 검사해야 나중에 버튼 라벨이 바뀌어도 규칙이 지켜집니다.
    expect(screen.getByRole("button", { name: "검증 근거 보강 승인" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "검증 근거 보강 거절" })).toBeDisabled();
  });

  // 헌법 4.8의 «보수적 채택»은 채택 전후 효과 비교와 악화 시 되돌리기로만 증명됩니다.
  // 검토 대기만 보이면 그 근거가 화면에 없는 것과 같으므로 네 상태를 함께 고정합니다.
  it("개선은 검토 대기·채택·되돌림·거부를 한 화면에서 구분한다", async () => {
    const user = userEvent.setup();
    render(<App service={service()} />);

    await user.click(screen.getByRole("button", { name: "개선" }));
    const growth = await screen.findByRole("main", { name: "개선" });
    const list = within(growth).getByRole("region", { name: "개선 제안 목록" });

    await user.click(within(list).getByRole("tab", { name: /전체/u }));
    for (const label of ["승인 대기", "반영됨", "되돌림", "거부됨"]) {
      expect(within(list).getAllByText(label).length).toBeGreaterThan(0);
    }

    // 자동 채택 + 개선 확인. 무엇을 어떻게 쟀는지가 표본 수와 함께 보여야 합니다.
    await user.click(within(list).getByText("인계할 때 해소하지 못한 질문을 함께 넘깁니다."));
    expect(within(growth).getByRole("region", { name: "채택" })).toHaveTextContent("자동");
    // 라벨과 값이 별도 칸이라 붙어 읽힙니다. 값이 맞는지만 봅니다.
    expect(within(growth).getByRole("region", { name: "적용 후 측정" })).toHaveTextContent(/표본\s*14 \/ 최소 10/u);
    // 좋아졌는지 나빠졌는지를 문장이 아니라 부호가 말해야 합니다.
    expect(within(growth).getByRole("region", { name: "적용 후 측정" })).toHaveTextContent("▲0.17");
    expect(within(growth).getByText("개선 확인")).toBeInTheDocument();

    // 사람 채택 + 저하 관찰 → 되돌림. 되돌린 시각이 채택 계보와 같은 자리에 있어야 합니다.
    await user.click(within(list).getByText("수치 결론에는 독립 검증을 두 번 거칩니다."));
    const adoption = within(growth).getByRole("region", { name: "채택" });
    expect(adoption).toHaveTextContent("사람");
    expect(adoption).toHaveTextContent("approval-growth-0018");
    // 화살표가 별도 칸이라 붙어 읽힙니다. 되돌렸으면 지금 사는 것이 이전 버전임도 함께 말해야 합니다.
    expect(adoption).toHaveTextContent(/policy-assurance-v3\s*→\s*policy-assurance-v4/u);
    expect(adoption).toHaveTextContent("현재 이전 버전");
    expect(adoption).toHaveTextContent("효과 저하");
    expect(within(growth).getByText("저하 관찰")).toBeInTheDocument();

    // 사람이 거부한 것은 사유가 남아야 합니다. 도메인이 거절에 결정 계보를 강제합니다.
    await user.click(within(list).getByText("모든 보고를 5줄 이내로 고정합니다."));
    expect(within(growth).getByRole("region", { name: "거부" })).toHaveTextContent(
      "규제 검토 보고는 근거를 줄이면 다시 물어야 해서 길이를 고정하지 않는다",
    );
    expect(within(growth).queryByRole("region", { name: "채택" })).not.toBeInTheDocument();
  });

  it("성장 기록이 없으면 검증된 실행 기록을 기다리는 빈 상태를 표시한다", async () => {
    const user = userEvent.setup();
    const loadGrowth = vi.fn(async () => ({ memories: [], suggestions: [], effects: [] }));
    render(<App service={service({ loadGrowth })} />);

    await user.click(screen.getByRole("button", { name: "개선" }));

    expect(await screen.findByText("조직이 아직 바꾸자고 제안한 것이 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("직접 저장한 기억이 없습니다.")).toBeInTheDocument();
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
    const subscribed = deferred<undefined>();
    const stop = vi.fn(async () => {
      throw new Error("이미 종료된 stream입니다");
    });
    const fake = service({
      subscribeDurable: async () => {
        subscribed.resolve(undefined);
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
    await user.click(screen.getByRole("button", { name: "보내기" }));

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
    const workspace = {
      workspaceId: "workspace-0001",
      name: "계약 폴더",
      path: "/tmp/contracts",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const fake = service({
      startWork,
      loadWorkspaces: async () => [workspace],
      loadIndex: async () => (createdVisible ? [...snapshot.works, created] : snapshot.works),
      loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/contracts/src/contract.ts"]),
    };
    render(<App contextPicker={contextPicker} service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "파트너 계약 위험을 검토해줘");
    await user.click(await within(dialog).findByRole("button", { name: /계약 폴더/ }));
    const attachmentStatus = within(dialog).getByRole("status", { name: "파일 첨부 상태" });
    expect(attachmentStatus).toBeEmptyDOMElement();
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    expect(attachmentStatus).toHaveTextContent("파일을 첨부했습니다: src/contract.ts");
    await user.click(within(dialog).getByRole("button", { name: "실행 시작" }));

    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();
    expect(screen.getByText("run-created-0001")).toBeInTheDocument();
    expect(startWork).toHaveBeenCalledWith({
      text: "파트너 계약 위험을 검토해줘",
      workspaceId: "workspace-0001",
      workspacePaths: ["src/contract.ts"],
    });

    createdVisible = true;
    durable?.({ sequence: 12, type: "work.created", resource: { type: "Work", id: created.id } });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
  });

  it("Work 생성 이벤트가 실행 원장보다 먼저 와도 다음 이벤트에서 임시 행을 해소한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-before-run-0001",
      title: "실행 원장 순서 확인",
      run: { runId: "run-created-before-run-0001", status: "running", stage: "intake", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let createdVisible = false;
    let runVisible = false;
    const startWork = vi.fn(async () => ({ runId: "run-created-before-run-0001" }));
    const { run: _unusedRun, ...createdWithoutRun } = created;
    void _unusedRun;
    const fake = service({
      startWork,
      loadIndex: async () => (createdVisible ? [...snapshot.works, createdWithoutRun] : snapshot.works),
      loadWork: async (workId) =>
        workId === created.id ? (runVisible ? created : createdWithoutRun) : (snapshot.works[0] as WorkView),
      subscribeDurable: async (handler) => {
        durable = handler;
        return async () => undefined;
      },
    });
    render(<App service={fake} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "실행 원장 순서를 확인해줘");
    await user.click(within(dialog).getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    createdVisible = true;
    durable?.({ sequence: 12, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(screen.getByText("Work 생성 중")).toBeInTheDocument());

    runVisible = true;
    durable?.({
      sequence: 13,
      type: "runtime.execution-running",
      resource: { type: "Execution", id: "execution-0001" },
    });
    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(startWork).toHaveBeenCalledOnce();
  });

  it("동시 durable batch의 첫 목록 응답이 stale이어도 다음 batch가 Work 생성을 해소한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created: WorkView = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-concurrent-0001",
      title: "동시 생성 후보 확인",
      run: { runId: "run-created-concurrent-0001", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    const firstEventLoad = deferred<WorkView[]>();
    let durable: ((event: unknown) => void) | undefined;
    let eventLoads = 0;
    let eventsStarted = false;
    const loadIndex = vi.fn(async () => {
      if (!eventsStarted) return snapshot.works;
      eventLoads += 1;
      if (eventLoads === 1) return await firstEventLoad.promise;
      firstEventLoad.resolve([...snapshot.works, created]);
      return [...snapshot.works, created];
    });
    render(
      <App
        service={service({
          startWork: async () => ({ runId: "run-created-concurrent-0001" }),
          loadIndex,
          loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "동시 생성 후보를 확인해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    eventsStarted = true;
    durable?.({ sequence: 41, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(eventLoads).toBe(1));
    durable?.({ sequence: 42, type: "run.claimed", payload: { workId: created.id } });
    await waitFor(() => expect(eventLoads).toBe(2));

    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    await waitFor(() => expect(loadIndex).toHaveBeenCalled());
    expect(screen.queryByText("Work 생성 중")).not.toBeInTheDocument();
  });

  it("Work 후보의 첫 목록 조회가 실패해도 다음 durable batch 성공으로 생성을 해소한다", async () => {
    const user = userEvent.setup();
    const snapshot = fixtureDataAdapter();
    const created: WorkView = {
      ...(snapshot.works[1] as WorkView),
      id: "work-created-retry-0001",
      title: "실패 뒤 생성 후보 확인",
      run: { runId: "run-created-retry-0001", status: "running", stage: "delivery", leaseGeneration: 1 },
    };
    let durable: ((event: unknown) => void) | undefined;
    let eventLoads = 0;
    let eventsStarted = false;
    const loadIndex = vi.fn(async () => {
      if (!eventsStarted) return snapshot.works;
      eventLoads += 1;
      if (eventLoads === 1) throw new Error("첫 생성 목록 조회 실패");
      return [...snapshot.works, created];
    });
    render(
      <App
        service={service({
          startWork: async () => ({ runId: "run-created-retry-0001" }),
          loadIndex,
          loadWork: async (workId) => (workId === created.id ? created : (snapshot.works[0] as WorkView)),
          subscribeDurable: async (handler) => {
            durable = handler;
            return async () => undefined;
          },
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    await user.type(screen.getByRole("textbox", { name: "업무 요청" }), "실패 뒤 생성 후보를 확인해줘");
    await user.click(screen.getByRole("button", { name: "실행 시작" }));
    expect(await screen.findByText("Work 생성 중")).toBeInTheDocument();

    eventsStarted = true;
    durable?.({ sequence: 51, type: "work.created", resource: { type: "Work", id: created.id } });
    await waitFor(() => expect(eventLoads).toBe(1));
    expect(screen.getByText("Work 생성 중")).toBeInTheDocument();
    durable?.({ sequence: 52, type: "run.claimed", payload: { workId: created.id } });

    expect(await screen.findByRole("main", { name: created.title }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByText("Work 생성 중")).not.toBeInTheDocument();
  });

  it("네이티브 선택 취소와 워크스페이스 밖 파일은 현재 draft를 보존한다", async () => {
    const user = userEvent.setup();
    const workspace = {
      workspaceId: "workspace-picker-0001",
      name: "선택 폴더",
      path: "/tmp/picker",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(["/tmp/outside.ts"]),
    };
    render(<App contextPicker={contextPicker} service={service({ loadWorkspaces: async () => [workspace] })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    await user.type(request, "선택 취소 뒤에도 남아야 하는 요청");
    await user.click(await within(dialog).findByRole("button", { name: /선택 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));

    expect(request).toHaveValue("선택 취소 뒤에도 남아야 하는 요청");
    expect(within(dialog).getByRole("button", { name: /선택 폴더/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("선택한 파일은 현재 워크스페이스 안에 있어야 합니다.")).toBeInTheDocument();
  });

  it("폴더 등록 중에는 Work 문맥을 바꾸거나 실행하지 않고 완료 후 새 폴더를 선택한다", async () => {
    const user = userEvent.setup();
    const registered = deferred<{
      workspaceId: string;
      name: string;
      path: string;
      kind: "local-directory";
      trust: "pending";
      status: "active";
      revision: number;
      createdAt: string;
      lastUsedAt: string;
    }>();
    const current = {
      workspaceId: "workspace-current",
      name: "현재 폴더",
      path: "/tmp/current",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const added = {
      workspaceId: "workspace-added",
      name: "새 폴더",
      path: "/tmp/added",
      kind: "local-directory" as const,
      trust: "pending" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const startWork = vi.fn(async () => ({ runId: "run-unexpected" }));
    const registerWorkspace = vi.fn(async () => await registered.promise);
    const contextPicker = {
      pickDirectory: vi.fn(async () => "/tmp/added"),
      pickFiles: vi.fn(async () => ["/tmp/current/src/keep.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({ loadWorkspaces: async () => [current], registerWorkspace, startWork })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.type(within(dialog).getByRole("textbox", { name: "업무 요청" }), "등록 중인 폴더를 기다려줘");
    await user.click(await within(dialog).findByRole("button", { name: /현재 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: "폴더 추가" }));
    await waitFor(() => expect(registerWorkspace).toHaveBeenCalledWith("/tmp/added"));

    expect(within(dialog).getByRole("button", { name: /현재 폴더/ })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "폴더 추가" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "파일 첨부" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "src/keep.ts 제거" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "실행 시작" })).toBeDisabled();
    expect(startWork).not.toHaveBeenCalled();

    registered.resolve(added);
    expect(await within(dialog).findByRole("button", { name: /새 폴더/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).queryByText("src/keep.ts")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "폴더 추가" })).toBeEnabled();
  });

  it("네이티브 파일 선택기 오류를 표시하고 draft를 보존한다", async () => {
    const user = userEvent.setup();
    const workspace = {
      workspaceId: "workspace-picker-error",
      name: "오류 확인 폴더",
      path: "/tmp/picker-error",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn().mockRejectedValueOnce(new Error("dialog unavailable")).mockResolvedValueOnce([]),
    };
    render(<App contextPicker={contextPicker} service={service({ loadWorkspaces: async () => [workspace] })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    await user.type(request, "선택기 오류 뒤에도 남아야 하는 요청");
    await user.click(await within(dialog).findByRole("button", { name: /오류 확인 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));

    expect(await within(dialog).findByText("파일 선택기를 열지 못했습니다.")).toBeInTheDocument();
    expect(request).toHaveValue("선택기 오류 뒤에도 남아야 하는 요청");
    expect(within(dialog).getByRole("button", { name: /오류 확인 폴더/ })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await waitFor(() => expect(within(dialog).queryByText("파일 선택기를 열지 못했습니다.")).not.toBeInTheDocument());
    expect(request).toHaveValue("선택기 오류 뒤에도 남아야 하는 요청");
  });

  it("새 Work 요청 실패 시 입력을 보존하고 중복 실행을 막는다", async () => {
    const user = userEvent.setup();
    const started = deferred<{ runId: string }>();
    const startWork = vi.fn(async () => await started.promise);
    const workspace = {
      workspaceId: "workspace-0002",
      name: "운영 폴더",
      path: "/tmp/operations",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    render(<App service={service({ startWork, loadWorkspaces: async () => [workspace] })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    const request = within(dialog).getByRole("textbox", { name: "업무 요청" });
    const submit = within(dialog).getByRole("button", { name: "실행 시작" });
    await user.type(request, "월간 운영 지표를 분석해줘");
    await user.click(await within(dialog).findByRole("button", { name: /운영 폴더/ }));
    await user.click(submit);
    await user.click(submit);

    expect(startWork).toHaveBeenCalledOnce();
    started.reject(new Error("실행을 시작하지 못했습니다"));
    expect(await within(dialog).findByText("실행을 시작하지 못했습니다")).toBeInTheDocument();
    expect(request).toHaveValue("월간 운영 지표를 분석해줘");
    expect(within(dialog).getByRole("button", { name: /운영 폴더/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("다른 워크스페이스를 선택하면 이전 파일 첨부를 지운다", async () => {
    const user = userEvent.setup();
    const workspace = (workspaceId: string, name: string) => ({
      workspaceId,
      name,
      path: `/tmp/${workspaceId}`,
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    });
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/workspace-a/src/a.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({
          loadWorkspaces: async () => [workspace("workspace-a", "A 폴더"), workspace("workspace-b", "B 폴더")],
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /A 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: /B 폴더/ }));

    expect(within(dialog).queryByText("src/a.ts")).not.toBeInTheDocument();
  });

  it("다시 열어 정상 목록을 받으면 이전 workspace load 오류를 지운다", async () => {
    const user = userEvent.setup();
    const loadWorkspaces = vi
      .fn()
      .mockRejectedValueOnce(new Error("워크스페이스를 불러오지 못했습니다"))
      .mockResolvedValueOnce([]);
    render(<App service={service({ loadWorkspaces })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    expect(await within(dialog).findByText("워크스페이스를 불러오지 못했습니다")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "새 Work 닫기" }));
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));

    expect(await screen.findByText("저장된 폴더가 없습니다.")).toBeInTheDocument();
    expect(screen.queryByText("워크스페이스를 불러오지 못했습니다")).not.toBeInTheDocument();
  });

  it("다시 열 때 차단된 workspace는 선택과 파일 draft에서 제거한다", async () => {
    const user = userEvent.setup();
    const active = {
      workspaceId: "workspace-reconciled-0001",
      name: "변경될 폴더",
      path: "/tmp/reconciled",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const blocked = { ...active, trust: "blocked" as const, revision: 2 };
    const loadWorkspaces = vi.fn().mockResolvedValueOnce([active]).mockResolvedValueOnce([blocked]);
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/reconciled/src/attached.ts"]),
    };
    render(<App contextPicker={contextPicker} service={service({ loadWorkspaces })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    let dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /변경될 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    await user.click(within(dialog).getByRole("button", { name: "새 Work 닫기" }));
    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    dialog = screen.getByRole("dialog", { name: "새 Work" });

    expect(await within(dialog).findByText("차단된 폴더는 선택할 수 없습니다.")).toBeInTheDocument();
    expect(within(dialog).queryByText("src/attached.ts")).not.toBeInTheDocument();
  });

  it("늦은 A 신뢰 응답이 이후 선택한 B workspace와 파일 draft를 덮어쓰지 않는다", async () => {
    const user = userEvent.setup();
    const trust = deferred<{
      workspaceId: string;
      name: string;
      path: string;
      kind: "local-directory";
      trust: "trusted";
      status: "active";
      revision: number;
      createdAt: string;
      lastUsedAt: string;
    }>();
    const pending = {
      workspaceId: "workspace-pending-a",
      name: "A 폴더",
      path: "/tmp/a",
      kind: "local-directory" as const,
      trust: "pending" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const trusted = {
      workspaceId: "workspace-trusted-b",
      name: "B 폴더",
      path: "/tmp/b",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const contextPicker = {
      pickDirectory: vi.fn(async () => undefined),
      pickFiles: vi.fn(async () => ["/tmp/b/src/b.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({
          loadWorkspaces: async () => [pending, trusted],
          decideWorkspaceTrust: async () => await trust.promise,
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /A 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "신뢰" }));
    await user.click(within(dialog).getByRole("button", { name: /B 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    trust.resolve({ ...pending, trust: "trusted", revision: 2 });

    await waitFor(() => expect(within(dialog).getByRole("button", { name: /A 폴더/ })).toHaveTextContent("신뢰됨"));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: /B 폴더/ })).toHaveAttribute("aria-pressed", "true"),
    );
    expect(within(dialog).getByText("src/b.ts")).toBeInTheDocument();
  });

  it("워크스페이스를 불러오는 동안 공간을 유지하고 차단된 폴더는 설정으로 안내한다", async () => {
    const user = userEvent.setup();
    const loading = deferred<
      readonly {
        workspaceId: string;
        name: string;
        path: string;
        kind: "local-directory";
        trust: "blocked";
        status: "active";
        revision: number;
        createdAt: string;
        lastUsedAt: string;
      }[]
    >();
    render(<App service={service({ loadWorkspaces: async () => await loading.promise })} />);

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    expect(within(dialog).getByLabelText("워크스페이스 불러오는 중")).toBeInTheDocument();
    loading.resolve([
      {
        workspaceId: "workspace-blocked-0001",
        name: "차단된 폴더",
        path: "/tmp/blocked",
        kind: "local-directory",
        trust: "blocked",
        status: "active",
        revision: 1,
        createdAt: "2026-07-24T00:00:00.000Z",
        lastUsedAt: "2026-07-24T00:00:00.000Z",
      },
    ]);
    await user.click(await within(dialog).findByRole("button", { name: "설정으로 이동" }));

    expect(await screen.findByRole("main", { name: "설정" })).toBeInTheDocument();
  });

  it("폴더 등록은 이전 파일 draft를 지우고 신뢰 충돌 뒤 목록을 다시 읽는다", async () => {
    const user = userEvent.setup();
    const current = {
      workspaceId: "workspace-current-0001",
      name: "현재 폴더",
      path: "/tmp/current",
      kind: "local-directory" as const,
      trust: "trusted" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const added = {
      workspaceId: "workspace-added-0001",
      name: "새 폴더",
      path: "/tmp/added",
      kind: "local-directory" as const,
      trust: "pending" as const,
      status: "active" as const,
      revision: 1,
      createdAt: "2026-07-24T00:00:00.000Z",
      lastUsedAt: "2026-07-24T00:00:00.000Z",
    };
    const refreshed = { ...added, revision: 2 };
    const loadWorkspaces = vi.fn().mockResolvedValueOnce([current]).mockResolvedValueOnce([refreshed]);
    const contextPicker = {
      pickDirectory: vi.fn(async () => "/tmp/added"),
      pickFiles: vi.fn(async () => ["/tmp/current/src/current.ts"]),
    };
    render(
      <App
        contextPicker={contextPicker}
        service={service({
          loadWorkspaces,
          registerWorkspace: async () => added,
          decideWorkspaceTrust: async () => {
            throw new Error("workspace revision이 일치하지 않습니다");
          },
        })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "새 Work 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "새 Work" });
    await user.click(await within(dialog).findByRole("button", { name: /현재 폴더/ }));
    await user.click(within(dialog).getByRole("button", { name: "파일 첨부" }));
    expect(within(dialog).getByText("src/current.ts")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "폴더 추가" }));
    expect(within(dialog).queryByText("src/current.ts")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "신뢰" }));

    expect(await within(dialog).findByText("workspace revision이 일치하지 않습니다")).toBeInTheDocument();
    expect(loadWorkspaces).toHaveBeenCalledTimes(2);
    expect(within(dialog).getByRole("button", { name: /새 폴더/ })).toHaveAttribute("aria-pressed", "true");
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
    expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
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
    await user.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(resumeRun).toHaveBeenCalledWith(blocked);
  });
});
