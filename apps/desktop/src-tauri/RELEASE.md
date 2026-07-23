# macOS arm64 릴리스 빌드

`apps/desktop`에서 릴리스 설정을 명시해 실행합니다.

```sh
pnpm tauri:build
```

빌드 단계는 `runtime-manifest.json`에 고정된 공식 Node.js와 SurrealDB 아카이브를 내려받아, 아카이브 SHA-256과 추출된 실행 파일 SHA-256을 모두 확인한 뒤 sidecar 입력을 준비합니다. 따라서 최종 사용자는 Node.js나 SurrealDB를 별도로 설치하거나 `PATH`에 등록할 필요가 없습니다.

빌드 머신에는 네트워크, `curl`, `tar`가 필요합니다. 이미 검증된 SurrealDB 실행 파일을 쓰려면 `MASSION_SURREAL_BINARY`에 절대 경로를 지정할 수 있으며, 이 경우에도 manifest의 실행 파일 SHA-256과 일치하지 않으면 빌드가 중단됩니다.

빌드 전 명령은 최신 renderer `dist`를 생성한 뒤, 브리지와 서버를 각각 의존성이 포함된 `.runtime-stage`로 배치합니다. 배포 앱은 SurrealDB 실행 파일을 앱 안에 포함하지만, 첫 실행 시 사용자 전용 데이터 경로에 무결성을 확인해 복사한 뒤 실행합니다. 데이터베이스 데이터도 같은 사용자 전용 경로에 저장되므로 앱 업데이트로 지워지지 않습니다.

실제 배포 전에는 서명된 `.app`에서 두 외부 바이너리의 위치, 브리지 `hello`/`shutdown`, 서버 재사용을 별도로 검증해야 합니다.
