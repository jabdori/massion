# 백업·복구 Runbook

## 1. 백업

Compose에서 실행 중인 Massion container의 동일 secret·network·backup volume을 재사용한다.

```sh
docker compose exec -T massion node dist/main.js backup /backups/massion-YYYYMMDDTHHMMSSZ.json
```

Kubernetes는 `massion-backup` CronJob을 사용한다. `concurrencyPolicy: Forbid`이며 기본 보존 기간은 30일이다. object storage로 복제할 때 Database credential과 다른 write-only credential을 사용한다.

성공 조건은 다음과 같다.

- file mode 0600
- `massion-operational-backup` format version 1
- SurrealDB engine version, AgentOS version, migration ID·checksum 목록
- SQL byte length와 SHA-256
- 동일 경로가 이미 있으면 덮어쓰지 않고 실패

## 2. 복구 rehearsal

운영 Database를 비우거나 덮어쓰지 않는다. 새 database 이름을 준비하고 다음처럼 복구한다.

```sh
docker compose exec -T \
  -e MASSION_DATABASE_NAME=massion_restore_YYYYMMDD \
  massion node dist/main.js restore /backups/massion-YYYYMMDDTHHMMSSZ.json
```

Kubernetes에서는 `restore-job.example.yaml`을 복사해 backup 파일과 새 database 이름을 지정하고 `suspend: false`로 바꾼다. 복구 후 migration ID·checksum, 핵심 query, `/health/ready`, Web/API smoke를 확인한 뒤 traffic 대상을 바꾼다.

## 3. 복구 실패 처리

- checksum 실패: 원본을 사용하지 말고 다른 retention copy를 선택한다.
- owner-only mode 실패: 파일 접근 권한과 복제 경로를 고친 뒤 재검증한다.
- target non-empty: 새 database를 사용한다. 강제 덮어쓰기는 지원하지 않는다.
- migration 계보 불일치: application traffic을 연결하지 않고 release와 backup의 version 조합을 확인한다.
- `OPTION IMPORT` 누락: 임의 추가하지 말고 공식 `surreal export` 또는 Massion bundle을 다시 만든다.

정기 logical export 하나만으로 시점 복구(point-in-time recovery)를 주장하지 않는다. 요구 복구 시점(RPO)이 더 짧으면 volume snapshot·replica·더 잦은 export를 함께 운영한다.

