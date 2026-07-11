# 자체 호스팅 장애 대응 Runbook

## 1. 준비 상태 실패

1. `/health/live`와 `/health/ready`를 각각 확인한다.
2. live 200·ready 503이면 process 재시작보다 Database·migration·drain 상태를 먼저 확인한다.
3. `server.readiness.failed`의 component code를 확인한다. 오류 원문·credential은 log에 없도록 설계돼 있다.
4. SurrealDB `is-ready`, volume 용량·권한, certificate와 network policy를 확인한다.

## 2. Extension crash loop

unexpected worker exit는 active contribution을 제거하고 `extension-restart`, `extension-rollback` 또는 `extension-review` action을 영속 queue에 넣는다. 제한 횟수 뒤 circuit이 open이면 무한 재시작하지 않는다.

- 직전 version이 healthy이고 recall되지 않았으며 permission 증가가 없고 정책이 허용할 때만 자동 rollback한다.
- 그 밖에는 사람 검토 action을 처리한다.
- 원인을 해결한 뒤 circuit을 명시적으로 reset한다.
- 같은 crash ID replay는 새 사건을 만들지 않고 누락된 queue action을 복구한다.

## 3. 종료 지연

첫 SIGTERM/SIGINT는 readiness를 내리고 HTTP·background·metric·Database 순으로 drain한다. 종료 기한을 넘기면 exit 1이다. 두 번째 signal은 즉시 force exit 1이다. 정상 restart log 순서는 `server.shutdown.started → server.shutdown.completed → server.ready`다.

## 4. 보안 사건

- 의심 Extension version을 Registry recall하고 새 설치·download·activation을 차단한다.
- Application token, Provider credential, Database owner credential과 TLS key를 각각 회전한다.
- audit·Registry recall·operation action·deployment event·backup manifest를 보존한다.
- secret 원문이 log, environment, argv 또는 image layer에 포함됐는지 별도로 조사한다.

장기 load·chaos·credential rotation과 sandbox 탈출 검증은 Phase 22 gate를 따른다.

