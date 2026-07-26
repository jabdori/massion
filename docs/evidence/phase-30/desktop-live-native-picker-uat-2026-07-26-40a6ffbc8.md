# 실제 Tauri native picker 증분 UAT — `40a6ffbc8`

> 동일 후보의 실제 `Massion.app`에서 새 Work 문맥 선택기가 macOS native panel을 호출하는지 확인한 증거입니다. 파일 선택 완료·전체 K UAT·공개 릴리스 완료를 주장하지 않습니다.

## 실행 경계

- 후보 커밋: `40a6ffbc84d5fe1659d2fb9533dcaabf3e7c6a59`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행: Tauri → WebView → `@tauri-apps/plugin-dialog` → macOS native panel
- 앱과 sidecar는 검증 후 종료했습니다.

## 실제 관측

| 행동 | 결과 |
| --- | --- |
| Work 목록의 `새 Work 만들기` | 실제 앱에서 새 Work dialog가 열림 — `/tmp/massion-native-picker-plus2.png` |
| `폴더 추가` | macOS native folder panel이 열림 — `/tmp/massion-native-folder-panel.png` |
| 폴더 선택 반환 | panel에서 현재 root를 선택하자 `/ (신뢰 필요)` workspace가 draft에 표시됨 — `/tmp/massion-native-users3.png` |
| 안전한 후속 처리 | root workspace를 `차단`하여 실행 권한을 부여하지 않음 — `/tmp/massion-native-folder-blocked.png` |
| `파일 첨부` | macOS native file panel이 열리고 취소 가능함 — `/tmp/massion-native-file-panel.png`, `/tmp/massion-native-picker-cancel.png` |

## 코드·회귀 확인

- `apps/desktop/src/native-context-picker.ts`가 `@tauri-apps/plugin-dialog`의 `open({ directory, multiple })`을 사용합니다.
- `apps/desktop/src-tauri/capabilities/default.json`에 `dialog:allow-open` 권한이 있습니다.
- `pnpm --filter @massion/desktop exec vitest run src/native-context-picker.test.ts --no-file-parallelism --maxWorkers=1 --reporter=dot` — 2/2 통과
- Computer Use의 `node_repl/@oai/sky` 런타임은 이 환경에 없어 AppleScript와 화면 캡처를 보조 수단으로 사용했습니다. 따라서 접근성 트리 기반 Computer Use 통과로 표시하지 않습니다.

## 남은 범위

- native file panel에서 실제 파일을 선택해 draft에 추가하고, 같은 workspace 경계로 `run.start`까지 완료하는 시나리오는 아직 남았습니다.
- 폴더 취소 후 draft 불변, 파일 선택 중복·workspace 밖 경로 차단, K01~K04 전체와 VoiceOver 실측도 남아 있습니다.
