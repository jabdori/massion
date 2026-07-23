# 데스크톱 홈·워크스페이스·파일 문맥 설계

> **상태:** 구현 기준 설계
> **관련 표면:** 홈, 새 Work 대화상자, 업무

## 1. 홈의 역할

홈은 여러 도메인의 깊은 상세를 복제하지 않습니다. 다음 세 질문만 답합니다.

1. 지금 무엇을 맡길 수 있는가 — `새 사명`
2. 무엇이 나를 기다리는가 — 전역 `InboxItem`
3. 조직이 지금 무엇을 하고 있는가 — 진행 중 Work

현재 `HomeSurface`의 세 블록을 유지합니다. 최근 완료 목록, 조직도 축소판, Provider 설정, 개선 근거를 추가하지 않습니다. 해당 정보는 각각 업무·조직·설정·개선 표면이 소유합니다. 홈의 새 사명 버튼은 기존 `NewWorkDialog`를 열고, 별도의 두 번째 입력기를 만들지 않습니다.

## 2. 새 사명 사용자 흐름

```text
새 사명
→ 요청 입력
→ 워크스페이스 없음 또는 기존 워크스페이스 선택
→ 필요하면 폴더 추가
→ pending 폴더면 경로·권한 확인 후 신뢰
→ 필요하면 폴더 안 파일 첨부
→ 실행 시작
→ 임시 생성 행
→ run 계보가 일치하는 Work가 보이면 업무 상세로 이동
```

### 기본 상태

- 요청만 필수입니다.
- 워크스페이스와 파일은 선택입니다.
- 디렉터리가 필요 없는 조사·판단 업무를 막지 않습니다.
- 내부 `workspaceId`는 표시하거나 입력받지 않습니다.

### 워크스페이스 선택

대화상자는 `workspace.list` 결과를 최근 사용 순으로 보여줍니다. 행에는 이름, 축약하지 않은 경로, 신뢰 상태만 표시합니다.

- `trusted`: 즉시 선택 가능
- `pending`: 선택 시 신뢰 확인 패널 표시
- `blocked`: 선택 불가, 차단 상태와 설정 이동 제공

`폴더 추가`는 macOS 네이티브 디렉터리 선택기를 엽니다. 취소하면 상태를 바꾸지 않습니다. 선택한 경로는 `workspace.register`로 등록하고, 새 폴더는 항상 `pending`에서 시작합니다.

신뢰 확인은 “이 폴더 안에서 에이전트가 읽기·쓰기 도구를 사용할 수 있습니다”와 실제 절대 경로를 보여줍니다. `신뢰`와 `차단`을 결정하며 revision 충돌 시 목록을 다시 읽습니다.

## 3. 파일 첨부의 최소 계약

첫 릴리스의 파일 첨부는 **선택한 워크스페이스 안의 기존 파일을 Work 입력 범위로 지정하는 기능**입니다. 파일을 복사하거나 외부 서버에 업로드하지 않습니다.

규칙:

- 워크스페이스를 먼저 선택해야 합니다.
- 한 Work는 기존 도메인대로 워크스페이스 하나만 가집니다.
- 파일은 선택한 루트 안의 regular file이어야 합니다.
- canonical path가 루트 밖으로 나가는 symlink는 거부합니다.
- 저장되는 값은 루트 기준 상대 경로입니다.
- 중복을 제거하고 최대 20개까지 허용합니다.
- 파일 내용은 선택 시 읽지 않고, 실행 중 승인된 workspace tool이 읽습니다.
- 파일 선택을 취소하면 기존 첨부를 유지합니다.

워크스페이스 밖 파일을 임의 복사하는 첨부 저장소와 여러 루트 지원은 이번 범위에 넣지 않습니다. 실제 사용에서 이 제한이 막힘으로 확인되면 input artifact 도메인을 별도로 설계합니다.

## 4. 계약 변경

### Application 조회·명령 타입

```ts
export interface WorkspaceViewV1 {
  readonly workspaceId: string;
  readonly name: string;
  readonly path: string;
  readonly kind: "local-directory";
  readonly trust: "pending" | "trusted" | "blocked";
  readonly status: "active" | "archived";
  readonly revision: number;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

export interface ApplicationQueryMapV1 {
  readonly "workspace.list": {
    readonly payload: Record<string, never>;
    readonly data: readonly WorkspaceViewV1[];
  };
  readonly "workspace.get": {
    readonly payload: { readonly workspaceId: string };
    readonly data: WorkspaceViewV1;
  };
}

export interface ApplicationCommandMapV1 {
  readonly "workspace.register": {
    readonly payload: { readonly path: string; readonly name?: string };
  };
  readonly "workspace.trust": {
    readonly payload: {
      readonly workspaceId: string;
      readonly decision: "trusted" | "blocked";
    };
  };
  readonly "workspace.archive": {
    readonly payload: { readonly workspaceId: string };
  };
}
```

`workspace.trust`와 `workspace.archive`의 revision은 Application command envelope의 `expectedRevision`을 사용합니다. payload에 두 번째 revision 필드를 만들지 않습니다.

### Work 시작 계약

```ts
export interface StartRunRequestV1 {
  readonly text: string;
  readonly surface?: string;
  readonly workspaceId?: string;
  readonly workspacePaths?: readonly string[];
  // 기존 필드 유지
}
```

`workspacePaths`는 `workspaceId`가 있을 때만 허용합니다. 각 값은 `/`로 시작하지 않는 정규화 상대 경로이고 빈 값, `.`·`..` 세그먼트, NUL을 거부합니다. Core Context & Strategy는 이 배열을 일반 자연어 `scopeIn`과 구분해 보존합니다.

### 데스크톱 서비스

```ts
export interface StartWorkInput {
  readonly text: string;
  readonly workspaceId?: string;
  readonly workspacePaths?: readonly string[];
}

export interface DesktopService {
  loadWorkspaces(): Promise<readonly WorkspaceViewV1[]>;
  registerWorkspace(path: string): Promise<WorkspaceViewV1>;
  decideWorkspaceTrust(workspace: WorkspaceViewV1, decision: "trusted" | "blocked"): Promise<WorkspaceViewV1>;
}
```

## 5. 네이티브 경계

Tauri의 공식 dialog plugin을 사용해 폴더와 파일 선택기만 엽니다. 범용 filesystem plugin은 추가하지 않습니다.

변경 위치:

- `apps/desktop/package.json`: `@tauri-apps/plugin-dialog`
- `apps/desktop/src-tauri/Cargo.toml`: `tauri-plugin-dialog`
- `apps/desktop/src-tauri/src/lib.rs`: plugin 등록
- `apps/desktop/src-tauri/capabilities/default.json`: 열기 대화상자 최소 권한
- `apps/desktop/src/native-context-picker.ts`: `pickWorkspaceDirectory`, `pickWorkspaceFiles`

렌더러에서 경로 포함 여부를 먼저 검사해 빠른 오류를 주되, 보안 판정은 daemon이 다시 합니다. `WorkspaceService.register`는 `realpath`와 `stat`으로 실제 디렉터리인지 확인하고, 파일 경로 검증은 Work 시작 직전 선택된 workspace의 canonical root를 기준으로 수행합니다.

## 6. 화면 상태

`NewWorkDialog`이 소유할 상태는 다음뿐입니다.

```ts
interface NewWorkDraft {
  readonly text: string;
  readonly workspace?: WorkspaceViewV1;
  readonly workspacePaths: readonly string[];
}
```

- 로딩: 워크스페이스 선택 영역 높이를 유지하는 skeleton
- 등록 실패: 요청·기존 선택·파일 목록 보존
- 신뢰 거절: 해당 폴더를 선택 해제하고 요청 보존
- Work 시작 실패: 전체 draft 보존, 중복 제출 차단
- 성공: 현재 구현처럼 draft를 지우고 run 계보가 맞는 Work만 자동 선택

## 7. 접근성·문구

- `폴더 추가`, `파일 첨부`, `신뢰`, `차단`, `실행 시작`처럼 결과를 말합니다.
- 폴더·파일 선택기는 버튼으로 접근 가능하고 선택 결과는 `aria-live`로 알립니다.
- 파일 chip마다 `… 제거` 이름을 가진 버튼을 둡니다.
- 키보드 Tab 순서는 요청→워크스페이스→파일→실행입니다.
- 경로는 감사 정보이므로 숨기지 않되 mono·보조 위계로 둡니다.

## 8. 최소 자동 검사

미리 작성할 테스트는 네 건입니다.

1. `WorkspaceService`가 존재하지 않는 경로·file·외부 symlink를 거부합니다.
2. `run.start`가 workspace 없는 `workspacePaths`와 루트 밖 경로를 거부합니다.
3. 데스크톱이 내부 ID 입력 없이 선택된 workspace와 상대 파일 경로를 `startWork`에 전달합니다.
4. 선택·등록·시작 실패 때 사용자가 입력한 draft를 보존합니다.

폴더 선택기 자체는 mock 단위 테스트를 늘리지 않고 실제 Tauri 시나리오로 검증합니다.

## 9. 완료 판정

- [ ] 홈에서 새 사명 진입이 항상 보인다
- [ ] 워크스페이스가 없어도 Work를 시작한다
- [ ] 기존 폴더와 새 폴더를 이름·경로로 선택한다
- [ ] 새 폴더의 신뢰 영향과 경로를 확인한다
- [ ] 워크스페이스 안 파일을 첨부하고 제거한다
- [ ] 워크스페이스 밖 파일과 탈출 symlink를 거부한다
- [ ] Work 상세에서 사용한 워크스페이스와 입력 파일을 확인한다
- [ ] renderer가 파일 내용을 직접 읽을 권한을 갖지 않는다

