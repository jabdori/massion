# 실제 Tauri native file panel 증분 UAT — `573297642`

> 이 기록은 제품 소스 후보 `573297642`에서 실제 Tauri 앱의 폴더·파일 패널을 호출한 증분 증거입니다. 파일 선택 완료·같은 Work 실행·23개 전체 UAT·서명·공증을 통과했다고 주장하지 않습니다.

<!-- desktop-uat-evidence: actual-tauri -->
<!-- desktop-release-candidate-sha: 573297642a41088a662aa58690ca16f2a43e84b6 -->

## 실행 경계

- 제품 후보 SHA: `573297642a41088a662aa58690ca16f2a43e84b6`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행: Tauri 앱 → bundled Node.js → bundled server → bundled SurrealDB 3.2.1
- 데이터: `/tmp/massion-native-file-uat-20260726-573297642`
- 빌드: `pnpm --filter @massion/desktop tauri:build` 성공
- Computer Use: `node_repl`/`@oai/sky` 런타임이 없어 사용하지 못했으며, macOS 화면 캡처와 AppleScript fallback으로 보조 확인했습니다.

## 실제 관측

| 시나리오 | 결과 |
| --- | --- |
| 새 Work 모달 | 실제 Tauri 화면에서 `새 Work 만들기` 모달을 열었습니다. |
| 폴더 선택 | macOS native folder panel에서 workspace directory를 반환하고 `신뢰`를 눌러 isolated profile에 등록했습니다. |
| 파일 첨부 | 같은 모달에서 macOS native file panel을 다시 열고 workspace의 파일 목록을 표시했습니다. |
| 파일 선택 완료 | 파일 행 선택과 `Open` 반환을 이 실행에서 확정하지 못했습니다. UAT-05는 미완료입니다. |
| 정리 | panel을 취소하고 Tauri·server·SurrealDB 프로세스를 종료했습니다. 포트 7331 listener가 남지 않았습니다. |

화면 보조 캡처:

- `/tmp/massion-native-file-uat-20260726-573297642-panel2.png`
- `/tmp/massion-native-file-uat-20260726-573297642-file-panel-final2.png`
- `/tmp/massion-native-file-uat-20260726-573297642-file-row2.png`

## 남은 게이트

- native file panel에서 실제 파일을 선택하고 같은 workspace의 `run.start`까지 동일 제품 후보에서 완료해야 합니다.
- 그 전까지 UAT-05 완료나 개인용 v1 릴리스 게이트 완료로 표시하지 않습니다.
