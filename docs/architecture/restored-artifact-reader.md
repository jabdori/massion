# Normal host reads exact relocated evidence

Issue #4's clean accepted-Work/artifact restore path existed in the backup CLI and custom fresh-process resolver. Audit above PR54 `c1786c0ef9ede9a33127ed352b805926e48c2c0b` found the normal CLI/UI path ended at a new local artifact store: original Record paths stayed immutable and could not be resolved after relocation. Existing injected HTTP-reader tests did not establish normal startup composition.

Acceptance chosen before implementation: explicitly select the existing private portable bundle and restored artifact root at normal host startup; validate exact inventory and current sealed bytes without DB import or filesystem initialization; allow the existing accepted/rejected text queries to resolve original descriptors. Retain original Record/path/checksum, journal and restored-held outbox. Missing, wrong, symlinked, hard-linked, malformed or tampered evidence fails closed. Reading and restart restore no grants, run no effects/providers and never claim unknown outcomes. Keep the existing normal artifact writer and fresh Work admission separate.

```sh
MASSION_SURREAL_RPC=http://127.0.0.1:8001/rpc \
MASSION_SURREAL_NAMESPACE=restored MASSION_SURREAL_DATABASE=restored \
node src/server.ts --restored-bundle /absolute/private-backup.json \
  --restored-artifact-root /absolute/restored-text-root
```

Both flags are required together, once each, with canonical absolute local paths. No path/config discovery or credential lookup is added. This opens existing restored data; it does not perform restore, grant access, run Work, enroll providers or replay outbox. Bundle checksums establish corruption detection, not authorship/authorization. The manifest is read once into a validated private reader; replacing it does not silently change the running host mapping. Every artifact read still validates current physical bytes and directory ownership markers. Listed descriptors never fall back to another location on failure; unlisted new normal artifacts use the normal writer's root. Runtime execution uses that existing writer, not the relocation reader.

Verification uses real backup CLI export/restore to a new empty disposable database/root, retained but unavailable original path, normal CLI startup and exact accepted-text route, native Chrome keyboard reading, literal rendering, widths 390/1280, host restart and unchanged Records/journal/outbox. Default startup remains unable to guess the relocation. Rejection tests cover file/path/manifest/root/byte integrity and separate new normal artifacts. This closes the normal restored-text inspection gap only. General formats, operational recovery, auth, signatures, live-provider quality, unknown recovery and full accessibility are outside this increment.
