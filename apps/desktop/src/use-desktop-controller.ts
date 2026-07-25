import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";

import type { DesktopFilter, DesktopService, DesktopWorkspaceView, StartWorkInput } from "@/desktop-service";
import type { ApprovalView, WorkView } from "@/model";

export type DesktopPhase = "loading" | "ready" | "error";

interface PendingCreation {
  runId: string;
  baselineWorkIds: ReadonlySet<string>;
}

interface ExecutionNotice {
  executionId: string;
  message: string;
}

export function useDesktopController(service: DesktopService) {
  const initialWorks = service.initialSnapshot?.works ?? [];
  const initialWork = initialWorks[0];
  const [phase, setPhase] = useState<DesktopPhase>(service.initialSnapshot ? "ready" : "loading");
  const [works, setWorks] = useState<WorkView[]>(initialWorks);
  const [selectedId, setSelectedIdState] = useState(initialWork?.id ?? "");
  const [work, setWork] = useState<WorkView | undefined>(initialWork);
  const [filter, setFilterState] = useState<DesktopFilter>("active");
  const [query, setQueryState] = useState("");
  const [composer, setComposer] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [rootError, setRootError] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [pendingDirective, setPendingDirective] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState<ReadonlySet<string>>(new Set());
  const [approvalDecisions, setApprovalDecisions] = useState<Record<string, "approved" | "rejected">>({});
  const [pendingRunAction, setPendingRunAction] = useState<"cancel" | "resume" | undefined>();
  const [pendingCreation, setPendingCreationState] = useState<PendingCreation | undefined>();
  const [newWorkOpen, setNewWorkOpen] = useState(false);
  const [newWorkText, setNewWorkText] = useState("");
  const [newWorkWorkspace, setNewWorkWorkspace] = useState<DesktopWorkspaceView | undefined>();
  const [newWorkWorkspaces, setNewWorkWorkspaces] = useState<readonly DesktopWorkspaceView[]>([]);
  const [newWorkWorkspacesLoading, setNewWorkWorkspacesLoading] = useState(false);
  const [newWorkWorkspacePaths, setNewWorkWorkspacePaths] = useState<readonly string[]>([]);
  const [newWorkError, setNewWorkError] = useState("");
  const [newWorkPickerError, setNewWorkPickerError] = useState("");
  const [newWorkWorkspaceLoadError, setNewWorkWorkspaceLoadError] = useState("");
  const [registeringWorkspace, setRegisteringWorkspace] = useState(false);
  const [startingWork, setStartingWork] = useState(false);
  const [executionNotice, setExecutionNotice] = useState<ExecutionNotice | undefined>();
  const [eventRevision, setEventRevision] = useState(0);
  const [retryVersion, setRetryVersion] = useState(0);

  const deferredQuery = useDeferredValue(query);
  const selectedIdRef = useRef(selectedId);
  const worksRef = useRef(works);
  const workRef = useRef(work);
  const newWorkWorkspaceRef = useRef<DesktopWorkspaceView | undefined>(newWorkWorkspace);
  const filterRef = useRef(filter);
  const queryRef = useRef(deferredQuery);
  const pendingCreationRef = useRef(pendingCreation);
  const durableWorkCandidatesRef = useRef(new Set<string>());
  const detailRequestRef = useRef(0);
  const indexRequestRef = useRef(0);
  const commandLocks = useRef(new Set<string>());

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    worksRef.current = works;
  }, [works]);
  useEffect(() => {
    workRef.current = work;
  }, [work]);
  useEffect(() => {
    filterRef.current = filter;
  }, [filter]);
  useEffect(() => {
    queryRef.current = deferredQuery;
  }, [deferredQuery]);
  useEffect(() => {
    pendingCreationRef.current = pendingCreation;
  }, [pendingCreation]);
  useEffect(() => {
    newWorkWorkspaceRef.current = newWorkWorkspace;
  }, [newWorkWorkspace]);
  useEffect(() => {
    if (!newWorkOpen) return;
    let active = true;
    setNewWorkWorkspacesLoading(true);
    setNewWorkWorkspaceLoadError("");
    void service.loadWorkspaces().then(
      (workspaces) => {
        if (active) {
          setNewWorkWorkspaces(workspaces);
          const selected = newWorkWorkspaceRef.current;
          const refreshed =
            selected === undefined ? undefined : workspaces.find((item) => item.workspaceId === selected.workspaceId);
          if (!refreshed || refreshed.status !== "active" || refreshed.trust === "blocked") {
            newWorkWorkspaceRef.current = undefined;
            setNewWorkWorkspace(undefined);
            setNewWorkWorkspacePaths([]);
          } else if (selected !== undefined) {
            newWorkWorkspaceRef.current = refreshed;
            setNewWorkWorkspace(refreshed);
          }
          setNewWorkWorkspaceLoadError("");
          setNewWorkWorkspacesLoading(false);
        }
      },
      (error: unknown) => {
        if (active) {
          setNewWorkWorkspaceLoadError(errorMessage(error, "워크스페이스를 불러오지 못했습니다."));
          setNewWorkWorkspacesLoading(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [newWorkOpen, service]);

  const setSelectedId = useCallback(
    (nextId: string) => {
      selectedIdRef.current = nextId;
      setSelectedIdState(nextId);
      const request = ++detailRequestRef.current;
      setDetailLoading(true);
      void service
        .loadWork(nextId)
        .then((next) => {
          if (request !== detailRequestRef.current || selectedIdRef.current !== nextId) return;
          workRef.current = next;
          setWork(next);
          setWorks((current) => current.map((value) => (value.id === next.id ? next : value)));
        })
        .catch((error: unknown) => {
          if (request !== detailRequestRef.current) return;
          setAnnouncement(errorMessage(error, "Work 상세 정보를 불러오지 못했습니다."));
        })
        .finally(() => {
          if (request === detailRequestRef.current) setDetailLoading(false);
        });
    },
    [service],
  );

  const applyIndex = useCallback(
    (next: WorkView[]) => {
      worksRef.current = next;
      setWorks(next);

      const currentId = selectedIdRef.current;
      if (!currentId) {
        if (pendingCreationRef.current) return;
        const first = next[0];
        if (first) setSelectedId(first.id);
      }
    },
    [setSelectedId],
  );

  const reloadIndex = useCallback(
    async (options: { surfaceError?: boolean } = {}): Promise<WorkView[] | undefined> => {
      const request = ++indexRequestRef.current;
      try {
        const next = await service.loadIndex({ filter: filterRef.current, search: queryRef.current });
        if (request !== indexRequestRef.current) return undefined;
        applyIndex([...next]);
        return [...next];
      } catch (error) {
        if (request !== indexRequestRef.current) return undefined;
        if (options.surfaceError) throw error;
        setAnnouncement(errorMessage(error, "Work 목록을 새로 고치지 못했습니다."));
        return undefined;
      }
    },
    [applyIndex, service],
  );

  useEffect(() => {
    let disposed = false;
    async function connect() {
      if (!service.initialSnapshot) setPhase("loading");
      setRootError("");
      try {
        await service.bootstrap();
        if (disposed) return;
        setPhase("ready");
        await reloadIndex({ surfaceError: !service.initialSnapshot });
      } catch (error) {
        if (disposed) return;
        setRootError(errorMessage(error, "로컬 AgentOS에 연결하지 못했습니다."));
        setPhase("error");
      }
    }
    void connect();
    return () => {
      disposed = true;
      detailRequestRef.current += 1;
      indexRequestRef.current += 1;
    };
  }, [reloadIndex, retryVersion, service]);

  useEffect(() => {
    if (phase !== "ready") return;
    void reloadIndex();
  }, [deferredQuery, filter, phase, reloadIndex]);

  useEffect(() => {
    if (phase !== "ready") return;
    let disposed = false;
    const isDisposed = () => disposed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => Promise<void>) | undefined;
    void service
      .subscribeDurable((event) => {
        if (disposed) return;
        const candidateWorkId = createdWorkId(event);
        if (candidateWorkId) durableWorkCandidatesRef.current.add(candidateWorkId);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          setEventRevision((current) => current + 1);
          const candidateWorkIds = [...durableWorkCandidatesRef.current];
          durableWorkCandidatesRef.current.clear();
          void (async () => {
            const next = await reloadIndex();
            if (disposed || !next) return;

            const creation = pendingCreationRef.current;
            if (creation) {
              for (const candidateId of candidateWorkIds) {
                if (creation.baselineWorkIds.has(candidateId) || !next.some((value) => value.id === candidateId))
                  continue;
                try {
                  const candidate = await service.loadWork(candidateId);
                  if (isDisposed() || pendingCreationRef.current?.runId !== creation.runId) return;
                  if (candidate.run?.runId !== creation.runId) continue;
                  detailRequestRef.current += 1;
                  pendingCreationRef.current = undefined;
                  setPendingCreationState(undefined);
                  selectedIdRef.current = candidate.id;
                  setSelectedIdState(candidate.id);
                  workRef.current = candidate;
                  setWork(candidate);
                  setWorks((current) => current.map((value) => (value.id === candidate.id ? candidate : value)));
                  setAnnouncement("새 Work가 생성되어 선택했습니다.");
                  return;
                } catch (error) {
                  if (!isDisposed()) setAnnouncement(errorMessage(error, "새 Work의 실행 계보를 확인하지 못했습니다."));
                }
              }
            }

            const current = workRef.current;
            if (current) setSelectedId(current.id);
            const value = asRecord(event);
            if (typeof value?.sequence === "number")
              setAnnouncement(`업데이트 ${String(value.sequence)}을 반영했습니다.`);
          })();
        }, 100);
      })
      .then(async (cleanup) => {
        if (disposed) await cleanup();
        else stop = cleanup;
      })
      .catch((error: unknown) => {
        if (!disposed) setAnnouncement(errorMessage(error, "업데이트 스트림에 연결하지 못했습니다."));
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (stop) stopStream(stop);
    };
  }, [phase, reloadIndex, service, setSelectedId]);

  useEffect(() => {
    const executionId = work?.activeExecutionId;
    if (phase !== "ready" || !executionId) {
      setExecutionNotice(undefined);
      return;
    }
    let disposed = false;
    let stop: (() => Promise<void>) | undefined;
    void service
      .subscribeExecution(executionId, (payload) => {
        if (disposed) return;
        const notice = executionMessage(payload, executionId);
        if (notice) setExecutionNotice({ executionId, message: notice });
      })
      .then(async (cleanup) => {
        if (disposed) await cleanup();
        else stop = cleanup;
      })
      .catch((error: unknown) => {
        if (!disposed) setAnnouncement(errorMessage(error, "실행 진행 스트림에 연결하지 못했습니다."));
      });
    return () => {
      disposed = true;
      if (stop) stopStream(stop);
    };
  }, [phase, service, work?.activeExecutionId]);

  const setFilter = (next: DesktopFilter) => {
    filterRef.current = next;
    setFilterState(next);
  };

  const setQuery = (next: string) => {
    setQueryState(next);
  };

  const submitDirective = async (mode: "now" | "next-stage") => {
    const current = workRef.current;
    const content = composer.trim();
    if (!current || !content || commandLocks.current.has("directive")) return;
    commandLocks.current.add("directive");
    setPendingDirective(true);
    setAnnouncement("지시를 저장하고 있습니다.");
    try {
      await service.submitDirective(current, content, mode);
      setComposer("");
      setAnnouncement(
        mode === "now" ? "안전한 실행 경계에서 지금 반영합니다." : "다음 단계에 반영하도록 예약했습니다.",
      );
      setSelectedId(current.id);
    } catch (error) {
      setAnnouncement(errorMessage(error, "지시를 저장하지 못했습니다."));
    } finally {
      commandLocks.current.delete("directive");
      setPendingDirective(false);
    }
  };

  const decideApproval = async (approval: ApprovalView, decision: "approved" | "rejected") => {
    const lock = `approval:${approval.id}`;
    if (commandLocks.current.has(lock)) return;
    commandLocks.current.add(lock);
    setPendingApprovals((current) => new Set(current).add(approval.id));
    try {
      const vote = decision === "approved" ? "approve" : "reject";
      const reason = decision === "approved" ? "데스크톱 Work 화면에서 검토 완료" : "데스크톱 Work 화면에서 거절";
      await service.decideApproval(approval, vote, reason);
      setApprovalDecisions((current) => ({ ...current, [approval.id]: decision }));
      setAnnouncement(
        decision === "approved" ? "승인되었습니다. 실행을 계속합니다." : "거절되었습니다. 실행을 중단했습니다.",
      );
      const currentWork = workRef.current;
      if (currentWork) setSelectedId(currentWork.id);
    } catch (error) {
      setAnnouncement(errorMessage(error, "승인 결정을 저장하지 못했습니다."));
    } finally {
      commandLocks.current.delete(lock);
      setPendingApprovals((current) => {
        const next = new Set(current);
        next.delete(approval.id);
        return next;
      });
    }
  };

  const controlRun = async (action: "cancel" | "resume") => {
    const current = workRef.current;
    if (!current?.run || commandLocks.current.has("run")) return;
    const canCancel = ["ready", "running", "awaiting-approval", "blocked"].includes(current.run.status);
    const canResume = current.run.status === "blocked";
    if ((action === "cancel" && !canCancel) || (action === "resume" && !canResume)) return;
    commandLocks.current.add("run");
    setPendingRunAction(action);
    try {
      if (action === "cancel") await service.cancelRun(current);
      else await service.resumeRun(current);
      setAnnouncement(action === "cancel" ? "실행 취소를 요청했습니다." : "실행 재개를 요청했습니다.");
      setSelectedId(current.id);
    } catch (error) {
      setAnnouncement(
        errorMessage(error, action === "cancel" ? "실행을 취소하지 못했습니다." : "실행을 재개하지 못했습니다."),
      );
    } finally {
      commandLocks.current.delete("run");
      setPendingRunAction(undefined);
    }
  };

  const startWork = async () => {
    const text = newWorkText.trim();
    if (!text || registeringWorkspace || commandLocks.current.has("start-work")) return;
    if (newWorkWorkspace?.trust === "pending") {
      setNewWorkError("선택한 폴더를 신뢰한 뒤 실행할 수 있습니다.");
      return;
    }
    commandLocks.current.add("start-work");
    setStartingWork(true);
    setNewWorkError("");
    const input: StartWorkInput = {
      text,
      ...(newWorkWorkspace === undefined ? {} : { workspaceId: newWorkWorkspace.workspaceId }),
      ...(newWorkWorkspacePaths.length === 0 ? {} : { workspacePaths: newWorkWorkspacePaths }),
    };
    try {
      const result = await service.startWork(input);
      const creation: PendingCreation = {
        runId: result.runId,
        baselineWorkIds: new Set(worksRef.current.map((value) => value.id)),
      };
      pendingCreationRef.current = creation;
      setPendingCreationState(creation);
      setNewWorkOpen(false);
      setNewWorkText("");
      newWorkWorkspaceRef.current = undefined;
      setNewWorkWorkspace(undefined);
      setNewWorkWorkspacePaths([]);
      setAnnouncement("새 Work 실행을 시작했습니다. Work 생성을 기다리고 있습니다.");
      await reloadIndex();
    } catch (error) {
      setNewWorkError(errorMessage(error, "새 Work 실행을 시작하지 못했습니다."));
    } finally {
      commandLocks.current.delete("start-work");
      setStartingWork(false);
    }
  };

  const registerWorkspace = async (path: string) => {
    if (!path || commandLocks.current.has("register-workspace")) return;
    commandLocks.current.add("register-workspace");
    setRegisteringWorkspace(true);
    setNewWorkError("");
    try {
      const workspace = await service.registerWorkspace(path);
      setNewWorkWorkspaces((current) => [
        workspace,
        ...current.filter((item) => item.workspaceId !== workspace.workspaceId),
      ]);
      newWorkWorkspaceRef.current = workspace;
      setNewWorkWorkspace(workspace);
      setNewWorkWorkspacePaths([]);
    } catch (error) {
      setNewWorkError(errorMessage(error, "폴더를 추가하지 못했습니다."));
    } finally {
      commandLocks.current.delete("register-workspace");
      setRegisteringWorkspace(false);
    }
  };

  const decideWorkspaceTrust = async (decision: "trusted" | "blocked") => {
    if (registeringWorkspace || !newWorkWorkspace || commandLocks.current.has("workspace-trust")) return;
    const requestedWorkspaceId = newWorkWorkspace.workspaceId;
    commandLocks.current.add("workspace-trust");
    setNewWorkError("");
    try {
      const workspace = await service.decideWorkspaceTrust(newWorkWorkspace, decision);
      setNewWorkWorkspaces((current) =>
        current.map((item) => (item.workspaceId === workspace.workspaceId ? workspace : item)),
      );
      if (newWorkWorkspaceRef.current?.workspaceId !== requestedWorkspaceId) return;
      if (decision === "trusted") {
        newWorkWorkspaceRef.current = workspace;
        setNewWorkWorkspace(workspace);
      } else {
        newWorkWorkspaceRef.current = undefined;
        setNewWorkWorkspace(undefined);
        setNewWorkWorkspacePaths([]);
      }
    } catch (error) {
      setNewWorkWorkspaceLoadError("");
      try {
        const workspaces = await service.loadWorkspaces();
        setNewWorkWorkspaces(workspaces);
        setNewWorkWorkspaceLoadError("");
        if (newWorkWorkspaceRef.current?.workspaceId === requestedWorkspaceId) {
          const refreshed = workspaces.find((item) => item.workspaceId === requestedWorkspaceId);
          if (!refreshed || refreshed.status !== "active" || refreshed.trust === "blocked") {
            newWorkWorkspaceRef.current = undefined;
            setNewWorkWorkspace(undefined);
            setNewWorkWorkspacePaths([]);
          } else {
            newWorkWorkspaceRef.current = refreshed;
            setNewWorkWorkspace(refreshed);
          }
        }
      } catch (reloadError) {
        // 신뢰 충돌 뒤 재조회 실패는 원래 오류를 덮어쓰지 않습니다.
        setNewWorkWorkspaceLoadError(errorMessage(reloadError, "워크스페이스를 불러오지 못했습니다."));
      }
      setNewWorkError(errorMessage(error, "폴더 신뢰 상태를 저장하지 못했습니다."));
    } finally {
      commandLocks.current.delete("workspace-trust");
    }
  };

  const addWorkspacePaths = (files: readonly string[]) => {
    if (registeringWorkspace || !newWorkWorkspace || files.length === 0) return;
    const paths = relativeWorkspacePaths(newWorkWorkspace.path, files);
    if (paths === undefined) {
      setNewWorkError("선택한 파일은 현재 워크스페이스 안에 있어야 합니다.");
      return;
    }
    setNewWorkError("");
    setNewWorkWorkspacePaths((current) => {
      const next = [...current];
      for (const path of paths) {
        if (next.length >= 20) break;
        if (!next.includes(path)) next.push(path);
      }
      return next;
    });
  };

  const visibleWorks = works.filter((value) => {
    const search = query.trim().toLocaleLowerCase("ko");
    return (
      (filter === "active" ? value.status === "active" : value.status !== "active") &&
      (!search || value.title.toLocaleLowerCase("ko").includes(search))
    );
  });

  return {
    announcement,
    approvalDecisions,
    composer,
    controlRun,
    decideApproval,
    detailLoading,
    executionNotice,
    eventRevision,
    filter,
    newWork: {
      error: [newWorkError, newWorkPickerError, newWorkWorkspaceLoadError].filter(Boolean).join(" "),
      open: newWorkOpen,
      setOpen: setNewWorkOpen,
      setText: setNewWorkText,
      setWorkspace: (workspace: DesktopWorkspaceView | undefined) => {
        if (registeringWorkspace || workspace?.trust === "blocked") return;
        newWorkWorkspaceRef.current = workspace;
        setNewWorkWorkspace(workspace);
        if (workspace?.workspaceId !== newWorkWorkspace?.workspaceId) {
          setNewWorkWorkspacePaths([]);
        }
      },
      addWorkspacePaths,
      removeWorkspacePath: (path: string) => {
        if (registeringWorkspace) return;
        setNewWorkWorkspacePaths((current) => current.filter((item) => item !== path));
      },
      registerWorkspace,
      registeringWorkspace,
      setPickerError: setNewWorkPickerError,
      decideWorkspaceTrust,
      start: startWork,
      starting: startingWork,
      text: newWorkText,
      workspace: newWorkWorkspace,
      workspacePaths: newWorkWorkspacePaths,
      workspaces: newWorkWorkspaces,
      workspacesLoading: newWorkWorkspacesLoading,
    },
    pendingApprovals,
    pendingCreation,
    pendingDirective,
    pendingRunAction,
    phase,
    query,
    retry: () => {
      setRetryVersion((current) => current + 1);
    },
    rootError,
    selectedId,
    setAnnouncement,
    setComposer,
    setFilter,
    setQuery,
    setSelectedId,
    submitDirective,
    visibleWorks,
    work,
    works,
  };
}

export function relativeWorkspacePaths(rootPath: string, files: readonly string[]): readonly string[] | undefined {
  const root = normalizeNativeRoot(rootPath);
  if (!root) return undefined;
  const rootDirectory = root === "/";
  const prefix = rootDirectory ? root : `${root}/`;
  const paths: string[] = [];
  for (const file of files) {
    if (!file || file === root || !file.startsWith(prefix)) return undefined;
    const relativePath = file.slice(root.length + (rootDirectory ? 0 : 1));
    if (!relativePath || relativePath.startsWith("/")) return undefined;
    paths.push(relativePath);
  }
  return paths;
}

function normalizeNativeRoot(path: string): string {
  return path === "/" ? path : path.replace(/\/+$/, "");
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function stopStream(stop: () => Promise<void>): void {
  void stop().catch(() => undefined);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function createdWorkId(value: unknown): string | undefined {
  const event = asRecord(value);
  if (event?.type !== "work.created") return undefined;
  const resource = asRecord(event.resource);
  return resource?.type === "Work" && typeof resource.id === "string" ? resource.id : undefined;
}

function executionMessage(value: unknown, executionId: string): string | undefined {
  const delta = asRecord(value);
  if (!delta || delta.executionId !== executionId) return undefined;
  if (delta.kind === "tool-call" && typeof delta.toolName === "string") return `${delta.toolName} 도구 실행 중`;
  if (delta.kind === "tool-result" && typeof delta.toolName === "string") return `${delta.toolName} 도구 실행 완료`;
  if (delta.kind === "lifecycle" && typeof delta.summary === "string") return delta.summary;
  if (delta.kind === "error") return typeof delta.summary === "string" ? delta.summary : "실행 오류 수신";
  if (delta.kind === "output-text") return "에이전트 응답을 생성하고 있습니다.";
  if (delta.kind === "reasoning") return "에이전트가 다음 단계를 검토하고 있습니다.";
  return undefined;
}
