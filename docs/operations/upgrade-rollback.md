# 업그레이드·Rollback Runbook

## 1. 원칙

업그레이드는 `preflight → backup → expand migration → 새 application rollout → readiness verify → 후속 release의 contract cleanup` 순서다. 이미 적용된 migration 파일 checksum을 바꾸거나 운영 DB에 down migration을 실행하지 않는다.

## 2. 사전 점검

- release image digest와 provenance를 확인한다.
- release note의 Node·SurrealDB·Extension compatibility를 확인한다.
- production dependency audit와 Phase 22 gate가 통과했는지 확인한다.
- 새 backup을 만들고 clean database restore rehearsal을 통과한다.
- Kubernetes라면 PDB, 여유 resource와 `maxSurge: 1` capacity를 확인한다.

## 3. Compose

1. backup과 restore rehearsal을 완료한다.
2. 새 image tag를 pull 또는 build한다.
3. `docker compose up -d --wait --wait-timeout 120`을 실행한다.
4. HTTPS readiness, Web/API, 제한 모드, metric과 log를 확인한다.

실패하면 이전 application/Caddy image로 되돌린다. migration 이후의 data가 이전 application과 호환되지 않으면 기존 DB를 역변형하지 않고, 검증된 backup을 새 clean database에 복구해 이전 image가 그 database를 보도록 바꾼다.

## 4. Kubernetes

1. overlay의 image digest를 갱신한다.
2. `kubectl diff -k`로 변경을 검토한다.
3. `kubectl apply -k`와 `kubectl rollout status`를 실행한다.
4. `ProgressDeadlineExceeded`, readiness와 error budget을 감시한다.
5. application-only 실패는 `kubectl rollout undo deployment/massion -n massion`을 사용한다.

Database schema 또는 data가 바뀐 실패는 Deployment undo만으로 완료하지 않는다. upgrade receipt의 backup path·checksum·적용 migration을 기준으로 clean-target restore 절차를 수행한다.

