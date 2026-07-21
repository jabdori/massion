# nimbalyst vendored source (clone-and-own)

이 디렉토리는 [Nimbalyst](https://github.com/Nimbalyst/nimbalyst) 의 프론트엔드 렌더러 소스를
복사하여 자체 버전 관리하는 사본입니다. npm 미배포 워크스페이스 전용 패키지이므로 depend가
아닌 vendor(복사) 방식으로 가져왔습니다.

- 출처: https://github.com/Nimbalyst/nimbalyst (MIT 라이선스)
- 반입 일시: 2026-07-21
- 반입 패키지: `nimbalyst`(runtime), `nimbalyst-extension-sdk`, `nimbalyst-collab-protocol`, `nimbalyst-collab-adapters`
- 테스트 파일(*.test.ts/__tests__)은 제외했습니다.

경로 별칭:
- vite: `apps/web/vite.config.ts` 의 resolve.alias 가 `@nimbalyst/*` → 이 디렉토리로 연결
- 타입: `apps/web/tsconfig.vendor.json`(moduleResolution Bundler, 완화 strict) 으로 별도 검사
- 메인 typecheck는 `apps/web/src/nimbalyst/vendor-shims.d.ts` 가 `@nimbalyst/*` 를 any 로 처리하여
  vendor 전체가 strict 프로그램으로 끌려들어오지 않게 합니다.

현재 활성 범위(v1): `ui/AIInput`(composer) + 디자인 토큰(themes/editor/themes/NimbalystTheme.css).
`ui/AgentTranscript`(lexical 기반)은 vendor에 보존되어 있으며 lazy-load 전환 후 다음 슬라이스에서 활성화합니다.
