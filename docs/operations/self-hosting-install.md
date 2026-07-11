# 자체 호스팅 설치 Runbook

## 1. 사전 조건

- Docker Engine 29+와 Docker Compose 2.40+ 또는 Kubernetes 1.34 호환 cluster
- Massion API와 외부 사용자를 연결할 DNS 이름
- 해당 DNS 이름의 PEM certificate chain과 private key
- 서로 다른 16자 이상 무작위 SurrealDB 소유자(root)·애플리케이션 런타임 비밀번호
- 서로 다른 token HMAC·Registry HMAC 32바이트 base64url 키

실제 secret은 repository, image, command argument와 일반 environment 값에 넣지 않는다. Compose는 file 경로, Kubernetes는 사전 생성한 `massion-secrets` Secret을 사용한다.

## 2. Docker Compose

1. `deploy/secrets/README.md`에 따라 여섯 secret 파일을 0600으로 준비한다.
2. `MASSION_DOMAIN`을 certificate의 DNS 이름으로 설정한다.
3. `docker compose config --quiet`로 최종 구성을 검토한다.
4. 소스 배포라면 `docker compose build`로 세 local image를 만든다. 릴리스 배포라면 증명을 확인한 OCI digest를 `MASSION_IMAGE`, `MASSION_SURREALDB_IMAGE`, `MASSION_CADDY_IMAGE`에 지정하고 `docker compose pull`을 실행한다.
5. 소스 배포는 `docker compose up -d --wait --wait-timeout 120`, 릴리스 배포는 `docker compose up -d --no-build --wait --wait-timeout 120`으로 시작한다.
6. `curl --fail https://$MASSION_DOMAIN/health/ready`가 `ready`를 반환하는지 확인한다.

외부에 공개되는 port는 Caddy의 443뿐이다. Massion 3141, metric 9464, SurrealDB 8000은 internal network에 남는다. `volume-init`은 named volume 소유권만 UID 1000으로 바꾸고 종료하며, 장기 실행 서비스는 모두 non-root다.

## 3. Kubernetes

1. `deploy/kubernetes/secret.example.yaml`의 실제 값으로 `massion-secrets`를 별도 생성하되 example 파일 자체는 적용하지 않는다.
2. image 이름, StorageClass, domain과 resource request/limit을 환경 overlay에서 바꾼다.
3. `kubectl kustomize deploy/kubernetes/base`를 검토한다.
4. `kubectl apply -k deploy/kubernetes/base` 후 `kubectl rollout status deployment/massion -n massion`을 확인한다.
5. StatefulSet과 Deployment readiness, PDB, NetworkPolicy와 LoadBalancer certificate를 확인한다.

기본 base는 Massion 1 replica `Recreate` Deployment와 SurrealDB 1 replica StatefulSet이다. 파일 artifact PVC가 `ReadWriteOnce`이므로 기본 구성을 복제본 2개로 늘리지 않는다. multi-node SurrealDB, 공유 object storage 또는 cloud-managed SurrealDB는 환경 overlay의 책임이며 기본 base가 고가용성 database를 주장하지 않는다.

## 4. 로컬 개인 모드

개인 설치 묶음의 `install.sh`를 실행한 뒤 `mass local start`를 사용한다. 이 명령은 loopback 전용 서버, 0600 token key, XDG 사용자 데이터 경로의 embedded SurrealDB를 준비한다. 이어서 `mass init http://127.0.0.1:7331 <email> <display name>`으로 첫 소유자·개인 조직·Core Office·기본 정책·일회 token을 만든다. 자세한 절차는 `local-install.md`를 따른다.

## 5. 설치 후 확인

- `/health/live`: process 생존
- `/health/ready`: Database·migration 준비 및 non-draining
- Web: HTTPS root에서 정적 자산 로드
- API: 인증 없는 `/api/v1/status`는 401
- container: read-only root filesystem, `cap_drop: ALL`, secret 원문 없는 environment
- log: `server.ready`가 한 번만 있고 `server.start.failed`가 없음
