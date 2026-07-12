# Phase 27 — Core 전환 허용 목록

이 목록은 Phase 1 구현 시작점(`9946b8a`)부터 export 시작 직전 clean HEAD까지의 history filter가 읽을 정본입니다. 목록의 파일만 새 비공개 Core 저장소의 모든 commit에 남길 수 있으며, 실제 export 전에 source range·tree digest·message 검사와 함께 다시 검토합니다.

## 포함 후보

- 제품 소스: `apps/`, `packages/`, `extensions/`, `scripts/`, `release/`, `deploy/`
- 현재 운영·제품 문서: `docs/architecture/`, `docs/operations/`, `docs/evidence/phase-24/`, `docs/phases/24-native-subscription-connectors/`, `docs/phases/25-model-optimization-lab/`, `docs/phases/26-gpt-5-6-migration/`, `docs/phases/27-clean-repository-cloud-separation/`
- build·검증 정본: 루트 `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.dockerignore`, `.prettierignore`, `.prettierrc.json`, `.gitignore`, `compose.yaml`, `Dockerfile`, `README.md`, `CHANGELOG.md`, `.github/`, 새 제품 README와 LICENSE/EULA가 소유자 결정 뒤 추가된 경우의 해당 파일

## 제외 후보

- `.git/`, `.worktrees/`, `.pnpm-store/`, `node_modules/`, `dist/`, cache, coverage, log, 임시 파일
- secret, 구독 profile, backup 원문, 실제 계정 데이터, 개인 경로와 개발 장치 설정
- legacy source lineage를 위한 코드·문서·브랜드 자료와 `docs/history/`
- `docs/superpowers/`, `docs/facts/`, 과거 Phase 문서와 새 제품의 현재 정본이 아닌 조사·실험 자료
- 관리형 서비스 사업 코드, URL·database·billing·fleet·SSO·SCIM·SLA 자료와 별도 서비스 저장소

제외한 기록은 삭제하지 않습니다. source commit, Git bundle, 파일 digest, 제외 사유와 검증 영수증을 private archive에 남겨 문제 추적에 사용합니다.
