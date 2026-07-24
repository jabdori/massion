# 백업·복구 후속 Runbook

> **개인용 1.0 상태:** 사용자용 백업·복구 UI와 왕복 UAT는 필수 범위가 아닙니다. 기존 내부 원시는 삭제하지 않고, 아래 승격 조건이 생길 때 후속 작업으로 실행합니다.

## 1. 개인용 데스크톱 현재 상태

개인용 백업의 하위 기능은 존재합니다.

- `LocalDaemonManager.backup()`이 daemon을 안전하게 멈추고 기존 server `backup` 명령을 실행한 뒤 이전 실행 상태를 복원합니다.
- 운영 백업은 owner-only regular file, `massion-operational-backup` format version 1, SQL 길이·SHA-256, 엔진 버전과 migration 계보를 검증합니다.
- `restoreOperationalBackup()`은 checksum과 owner-only mode를 검사하고 비어 있는 데이터베이스에만 복구합니다.

개인용 `LocalDaemonManager`와 데스크톱에는 복구 진입점이 없습니다. 이는 1.0 차단 항목이 아니며 공개 UI에서 지원 기능으로 안내하지 않습니다.

## 2. 승격 조건

다음 중 하나가 실제로 생기기 전에 개인용 백업·복구를 별도 작업으로 승격합니다.

- 기존 데이터를 바꾸는 첫 파괴적 schema migration
- 버전 간 자동 업데이트와 migration rollback
- 재생성하기 어려운 개인 Work·조직·Records가 축적된 실사용
- 외부 개인 사용자에게 복구 가능성을 지원 기능으로 약속하는 시점

그전에는 앱 교체·재설치 뒤 데이터 지속성, 비정상 종료 무결성, 호환 불가 데이터의 자동 삭제 금지만 검증합니다.

## 3. 후속 구현 계약

기존 백업 형식과 `restoreOperationalBackup()`을 재사용합니다. 별도 백업 형식이나 두 번째 복구 엔진을 만들지 않습니다.

1. 사용자가 저장 경로를 선택하고 백업을 실행합니다.
2. daemon과 SurrealDB sidecar를 Massion 소유 프로세스인지 확인한 뒤 멈춥니다.
3. 복구 파일의 regular-file·0600·크기·schema·checksum·migration을 검증합니다.
4. 현재 데이터베이스를 덮어쓰지 않고 격리된 빈 데이터베이스로만 복구합니다.
5. readiness와 핵심 Work·조직·승인·Records query를 확인합니다.
6. 검증 성공 뒤에만 복구 데이터로 전환하고 영수증을 남깁니다.
7. 어느 단계든 실패하면 기존 데이터와 설정을 그대로 유지합니다.

## 4. 후속 개인용 왕복 UAT

같은 후보 SHA에서 다음을 실제 데스크톱 앱으로 수행합니다.

- 고유하게 식별되는 Work, 승인 결과, 조직 변경, Records를 만듭니다.
- 백업을 만들고 SHA-256과 파일 권한을 기록합니다.
- 격리된 빈 XDG 데이터 경로로 복구합니다.
- 핵심 객체 수·식별자·revision·migration 계보를 백업 전과 대조합니다.
- 앱을 두 번 재시작해 같은 데이터가 보이고 중복 사건이 없는지 확인합니다.
- 손상된 checksum과 비어 있지 않은 대상 복구가 거부되는지 확인합니다.

이 왕복은 백업·복구를 지원 기능으로 승격할 때의 완료 조건이며 개인용 1.0 게시 조건이 아닙니다.

## 5. 팀 배포 백업

Compose에서 실행 중인 Massion container의 동일 secret·network·backup volume을 재사용합니다.

```sh
docker compose exec -T massion node dist/main.js backup /backups/massion-YYYYMMDDTHHMMSSZ.json
```

Kubernetes는 `massion-backup` CronJob을 사용합니다. `concurrencyPolicy: Forbid`이며 기본 보존 기간은 30일입니다. object storage로 복제할 때 Database credential과 다른 write-only credential을 사용합니다.

## 6. 팀 배포 복구 rehearsal

운영 데이터베이스를 비우거나 덮어쓰지 않습니다. 새 database 이름을 준비합니다.

```sh
docker compose run --rm --no-deps \
  -e MASSION_DATABASE_NAME=massion_restore_YYYYMMDD \
  database-provision node dist/main.js restore /backups/massion-YYYYMMDDTHHMMSSZ.json
```

복구는 owner provisioning secret을 가진 일회성 `database-provision` container에서만 실행합니다. 복구 후 migration ID·checksum, 핵심 query와 `/health/ready`를 확인한 뒤 traffic 대상을 바꿉니다.

## 7. 실패 처리

- checksum 실패: 원본을 사용하지 않고 다른 보존 사본을 선택합니다.
- owner-only mode 실패: 파일 권한과 복제 경로를 고친 뒤 다시 검증합니다.
- target non-empty: 새 데이터베이스를 사용합니다. 강제 덮어쓰기는 지원하지 않습니다.
- migration 계보 불일치: 애플리케이션을 연결하지 않고 후보 버전과 백업 조합을 확인합니다.
- readiness 또는 핵심 query 실패: 기존 데이터로 복귀하고 실패 증거를 남깁니다.
