# 실제 Tauri native file panel 증분 UAT — `be7a552cb`

> 이 기록은 같은 후보 SHA의 실제 Tauri 앱에서 파일 선택 패널을 호출한 증분 증거입니다. 파일 선택 완료·같은 Work 실행·23개 전체 UAT·서명·공증을 통과했다고 주장하지 않습니다.

## 실행 경계

- 후보 SHA: `be7a552cbd9414ccd1a200d2d6d308d7cb650445`
- 번들: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- 실행: Tauri 앱 → bundled Node.js → bundled server → bundled SurrealDB 3.2.1
- 데이터: `/tmp/massion-native-file-uat-20260726-be7`
- 빌드: `pnpm --filter @massion/desktop tauri:build` 성공
- Computer Use: `node_repl`/`@oai/sky` 런타임이 없어 사용하지 못했으며, macOS 화면 캡처와 AppleScript fallback으로 보조 확인했습니다.

## 실제 관측

| 시나리오 | 결과 |
| --- | --- |
| 새 Work 모달 | 실제 Tauri 화면에서 `새 Work 만들기` 모달을 열었습니다. |
| `파일 첨부` 호출 | macOS native file panel이 실제로 열렸습니다. |
| 파일 선택 | Go to Path 입력 overlay까지 열었으나, 이 실행에서는 선택 완료와 `README.md` 반환을 확정하지 못했습니다. |
| 취소·정리 | panel을 취소하고 Tauri·server·SurrealDB 프로세스를 종료했습니다. 포트 7331 listener가 남지 않았습니다. |

화면 보조 캡처는 다음 임시 파일에 있습니다.

- `/tmp/massion-native-file-uat-20260726-be7-new-work3.png`
- `/tmp/massion-native-file-uat-20260726-be7-file-panel3.png`
- `/tmp/massion-native-file-uat-20260726-be7-file-selected3.png`

## 남은 게이트

- native file panel에서 실제 파일을 선택하고 같은 workspace의 `run.start`까지 같은 후보 SHA로 완료해야 합니다.
- 그 전까지 UAT-05 완료나 개인용 v1 릴리스 게이트 완료로 표시하지 않습니다.
