# Compose secret 준비

이 directory에는 실제 secret을 commit하지 않습니다. 다음 네 파일을 owner-only 권한으로 준비합니다.

- `database-password`: 16자 이상의 SurrealDB root password
- `token-key`: `openssl rand -base64 32 | tr '+/' '-_' | tr -d '='` 결과
- `tls.crt`: 배포 hostname과 일치하는 PEM certificate chain
- `tls.key`: 위 certificate의 owner-only PEM private key

다른 경로를 쓰려면 `MASSION_DATABASE_PASSWORD_FILE`, `MASSION_TOKEN_KEY_FILE`, `MASSION_TLS_CERTIFICATE_FILE`, `MASSION_TLS_PRIVATE_KEY_FILE`을 설정합니다.
