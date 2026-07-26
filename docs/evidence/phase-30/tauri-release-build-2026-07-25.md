# Tauri ad-hoc 패키징 smoke — 2026-07-25

> 후보 SHA: c57f19c4b (feat/phase-30-reconciled HEAD)
> 빌드 시간: 1분 23초 (Rust release profile)
>
> 이 기록은 ad-hoc 패키징과 기동 smoke만 보존합니다. 실제 Tauri UAT, 동일 후보 SHA의 릴리스 게이트, 서명·공증, 공개 Release의 근거가 아닙니다.

## 빌드 결과

명령: `pnpm --filter @massion/desktop tauri:build`

빌드 산출물:
```
/Volumes/Crucial P3 PLUS/workspace.backup-20260502/massion/.worktrees/phase-30-reconciled/apps/desktop/src-tauri/target/release/bundle/macos/Massion.app
```

번들 정보:
- CFBundleIdentifier: dev.massion.desktop
- CFBundleShortVersionString: 1.0.0
- CFBundleVersion: 1.0.0
- LSMinimumSystemVersion: 10.13

## 서명 상태

- ad-hoc 서명 적용 (`codesign --force --deep --sign -`)
- `codesign --verify` 통과
- Apple Developer ID 서명·공증: 미적용 (인증서 없음)
- 공개 배포에는 Developer ID 서명 필요, 개인용 로컬 실행은 ad-hoc으로 가능

## 실행 검증

릴리즈 빌드 앱이 정상 시작함을 확인:
- Massion.app 프로세스 실행 (PID 11842)
- desktop-bridge 자식 프로세스 실행 (PID 12122, 번들 Resources 경로)
- WKWebView 윈도우 정상 표시 ("Massion" 창)

## 제약

- WKWebView 웹 콘텐츠가 macOS 접근성 트리에 노출되지 않아 Computer Use로
  시각 UAT 불가. 시각 UAT는 사용자가 직접 수행 필요.
- 외장 SSD의 .pnpm-store 심볼릭 링크 끊김을 수정(`/private/tmp/massion-pnpm-store-current`
  생성)한 뒤 빌드 성공.
