# 실제 Tauri artifact 서명·공증 gate — `573297642`

> 동일 후보 bundle에 macOS 배포 게이트 명령을 실행한 결과입니다. 현재 후보를 릴리스 가능 artifact로 승격하지 않습니다.

<!-- desktop-uat-evidence: actual-tauri -->
<!-- desktop-release-candidate-sha: 573297642a41088a662aa58690ca16f2a43e84b6 -->

## 대상

- 후보 SHA: `573297642a41088a662aa58690ca16f2a43e84b6`
- Bundle: `apps/desktop/src-tauri/target/release/bundle/macos/Massion.app`
- Bundle version: `1.0.0`
- 실행 파일: `massion-desktop` arm64

## 실제 결과

| 명령 | 결과 | 관측 |
| --- | --- | --- |
| `codesign --verify --deep --strict` | 실패 | `code has no resources but signature indicates they must be present` |
| `spctl --assess --type execute` | 실패 | 같은 bundle 서명/자원 봉인 오류로 평가 거부 |
| `xcrun stapler validate` | 실패 | `Massion.app does not have a ticket stapled to it` |

`codesign -dvvv`는 실행 파일의 `Signature=adhoc`, `TeamIdentifier=not set`, `Sealed Resources=none`을 반환했습니다. 이는 개발용 linker 서명 상태이며 Developer ID Application 서명이나 Apple 공증 결과가 아닙니다.

## 릴리스 판정

- 이 결과는 릴리스 자동 검증기가 후보를 거부해야 하는 상태와 일치합니다.
- Developer ID Application 인증서, hardened runtime 서명, Apple 공증·staple을 같은 후보 artifact에 적용한 뒤 세 명령을 다시 실행해야 합니다.
- ad-hoc 서명이나 서명되지 않은 bundle을 개인용 v1 공개 릴리스 근거로 사용하지 않습니다.
