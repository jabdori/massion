# 자체 호스팅 설치 Runbook

## 1. 사전 조건

- Docker Engine 29+와 Docker Compose 2.40+ 또는 Kubernetes 1.34 호환 cluster
- Massion API와 외부 사용자를 연결할 DNS 이름
- 해당 DNS 이름의 PEM certificate chain과 private key
- 16자 이상 무작위 SurrealDB root password
- `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`로 만든 token HMAC key

실제 secret은 repository, image, command argument와 일반 environment 값에 넣지 않는다. Compose는 file 경로, Kubernetes는 사전 생성한 `massion-secrets` Secret을 사용한다.

## 2. Docker Compose

1. `deploy/secrets/README.md`에 따라 네 secret 파일을 0600으로 준비한다.
2. `MASSION_DOMAIN`을 certificate의 DNS 이름으로 설정한다.
3. `docker compose config --quiet`로 최종 구성을 검토한다.
4. `docker compose build`로 세 local image를 만든다.
5. `docker compose up -d --wait --wait-timeout 120`으로 시작한다.
6. `curl --fail https://$MASSION_DOMAIN/health/ready`가 `ready`를 반환하는지 확인한다.

외부에 공개되는 port는 Caddy의 443뿐이다. Massion 3141, metric 9464, SurrealDB 8000은 internal network에 남는다. `volume-init`은 named volume 소유권만 UID 1000으로 바꾸고 종료하며, 장기 실행 서비스는 모두 non-root다.

## 3. Kubernetes

1. `deploy/kubernetes/secret.example.yaml`의 실제 값으로 `massion-secrets`를 별도 생성하되 example 파일 자체는 적용하지 않는다.
2. image 이름, StorageClass, domain과 resource request/limit을 환경 overlay에서 바꾼다.
3. `kubectl kustomize deploy/kubernetes/base`를 검토한다.
4. `kubectl apply -k deploy/kubernetes/base` 후 `kubectl rollout status deployment/massion -n massion`을 확인한다.
5. StatefulSet과 Deployment readiness, PDB, NetworkPolicy와 LoadBalancer certificate를 확인한다.

기본 base는 Massion 2 replica RollingUpdate와 SurrealDB 1 replica StatefulSet이다. multi-node SurrealDB 또는 cloud-managed SurrealDB는 환경 overlay의 책임이며 기본 base가 고가용성 database를 주장하지 않는다.

## 4. 로컬 개인 모드

`MASSION_MODE=local`은 loopback만 허용한다. token key는 0600 file로 지정하고 `MASSION_DATABASE_URL=rocksdb:///절대/경로`를 사용한다. 팀 구성과 달리 로컬 bootstrap endpoint에서 첫 owner·개인 조직·Core Office·기본 정책·일회 token을 만든다.

## 5. 설치 후 확인

- `/health/live`: process 생존
- `/health/ready`: Database·migration 준비 및 non-draining
- Web: HTTPS root에서 정적 자산 로드
- API: 인증 없는 `/api/v1/status`는 401
- container: read-only root filesystem, `cap_drop: ALL`, secret 원문 없는 environment
- log: `server.ready`가 한 번만 있고 `server.start.failed`가 없음

