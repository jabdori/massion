# Compose secret 준비

이 directory에는 실제 secret을 commit하지 않습니다. 다음 일곱 파일을 owner-only 권한으로 준비합니다.

- `database-owner-password`: 16자 이상의 SurrealDB root password. 1회 database provisioning에만 사용합니다.
- `database-password`: owner password와 다른 16자 이상의 `massion_runtime` password
- `token-key`: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` 결과
- `credential-key`: `token-key`와 다른 32 byte base64url key. 제공자(provider) API key 암호화에만 사용합니다.
- `registry-key`: `token-key`와 다른 32 byte base64url key
- `tls.crt`: 배포 hostname과 일치하는 PEM certificate chain
- `tls.key`: 위 certificate의 owner-only PEM private key

다른 경로를 쓰려면 `MASSION_DATABASE_OWNER_PASSWORD_FILE`, `MASSION_DATABASE_PASSWORD_FILE`, `MASSION_TOKEN_KEY_FILE`, `MASSION_CREDENTIAL_KEY_FILE`, `MASSION_REGISTRY_KEY_FILE`, `MASSION_TLS_CERTIFICATE_FILE`, `MASSION_TLS_PRIVATE_KEY_FILE`을 설정합니다.
