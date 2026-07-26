# UAT 실행 체크리스트 — 2026-07-25

> 이 문서는 진행 중인 구현의 자동화 검증과 아직 실행하지 않은 실제 시각 UAT·릴리스 단계를 분리해 기록한다.

## 사전 준비

```sh
cd "/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled"
pnpm install --frozen-lockfile
pnpm --filter @massion/desktop tauri:dev
```

## 자동화 검증 기록 (실제 UAT 대체 아님)

| 검증 | 결과 |
|------|------|
| application test (340개) | 통과 |
| server test (238개, 실제 SurrealDB) | 통과 |
| governance test (65개) | 통과 |
| growth test (96개) | 통과 |
| desktop test (89개) | 통과 |
| 전체 빌드 (21개 Web chunk) | 통과 |
| verify:docs | 통과 |
| Playwright UI (UAT-01,03,09,12,13,14,15,16) | 통과 (fixture 기반) |

## 시각 UAT 시나리오 (Tauri 앱에서 실행)

각 시나리오는 Tauri 앱을 열고 실제 Provider(Z.AI GLM Coding Plan)를 연결한 뒤 실행한다.

### UAT-01 첫 실행과 재연결
- [ ] 빈 격리 데이터로 앱 열기
- [ ] 홈·업무·조직·개선·확장·설정·수신함 탭 확인
- [ ] 앱 닫고 다시 열어 daemon·데이터 재사용 확인

### UAT-02 Provider 연결
- [ ] 설정에서 Provider 연결 열기
- [ ] Z_AI_API_KEY 비밀 입력
- [ ] Core route ready 상태 확인

### UAT-03 워크스페이스 없는 조사 Work
- [ ] 홈에서 단순 사명 입력 (워크스페이스 선택 안 함)
- [ ] Work 상세 자동 이동 확인
- [ ] Core 단계·Assurance 통과 확인

### UAT-04 워크스페이스 디렉터리 추가
- [ ] 네이티브 선택기로 Git 폴더 추가
- [ ] 경로·권한 영향 읽고 신뢰
- [ ] 같은 폴더 재추가 시 중복 방지 확인

### UAT-05 파일 첨부
- [ ] 워크스페이스에서 파일 2개 첨부, 1개 제거
- [ ] Work 시작 후 문맥 반영 확인

### UAT-06 워크스페이스 경계 거부
- [ ] 밖 파일·symlink 첨부 시 오류 확인

### UAT-07 실시간 협업방
- [ ] 복수 Agent 사명 시작
- [ ] handoff·answer 확인
- [ ] 앱 재시작 후 계보 유지 확인

### UAT-08 실행 중 추가 지시
- [ ] 실행 중 "다음 단계에 반영" 지시 제출
- [ ] 지시 상태·반영 확인

### UAT-09 승인과 수신함 정합성
- [ ] review 모드에서 승인 필요 작업 실행
- [ ] 홈·수신함·업무 대기 수 일치 확인
- [ ] 수신함에서 이동해 승인

### UAT-10 차단과 재개
- [ ] Provider 불가 조건에서 Work 시작
- [ ] blocked 상태 확인
- [ ] 조건 복구 후 재개

### UAT-11 취소
- [ ] 실행 중 Work 취소
- [ ] 앱 재시작 후 cancelled 유지 확인

### UAT-12 완료·산출물·Assurance
- [ ] 코드 변경 Work 끝까지 실행
- [ ] 산출물·검증·Records·completed 확인

### UAT-K01~K04 지식·기억
- [ ] K01: Workspace 색인·코드 관계·citation
- [ ] K02: 경로 경계·manifest 변경·stale 처리
- [ ] K03: 개인 기억 저장·재시작·새 Work 적용
- [ ] K04: 기억 사용 중지

### UAT-G01~G02 Growth
- [ ] G01: 기본 검토형 지속 발전
- [ ] G02: 사용자 선택 자동 반영과 복원

### UAT-P01~P02 전체 권한 (서명된 빌드 필요)
- [ ] P01: 전체 권한 활성화와 실행
- [ ] P02: 전체 권한 지속·회수·긴급 정지

### UAT-13~16 조직·확장·설정
- [ ] 13: 조직 구조·지도·제안
- [ ] 14: 개선 평가·승인·효과·되돌리기
- [ ] 15: 확장 설치와 실제 사용
- [ ] 16: 설정과 로컬 운영 상태

## 릴리즈 게이트

1. 위 시각 UAT 23개 시나리오 모두 통과
2. 깨끗한 클론에서 `pnpm verify` 통과
3. `pnpm --filter @massion/desktop tauri:build` 성공
4. Apple Developer ID 서명·공증
5. 깨끗한 macOS 설치·Gatekeeper 실행
6. 데이터 지속성·업데이트·제거 검증
7. `v1.0.0` 태그·GitHub Release
