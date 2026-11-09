# Back up and restore

A portable backup carries supported work history and sealed text results. It
keeps old accepted results and unknown outcomes without running them again.
It does **not** include host settings, credentials, connection configuration or
arbitrary workspace files. Keep those separately if you need the whole installation.

## Make a backup

Stop and drain every host using the database. Leave the database running for the
export. For the persistent web setup, from the same checkout:

```sh
mkdir -p .runtime/backups
node scripts/backup.ts export http://127.0.0.1:18080/rpc massion massion \
  "$(pwd -P)/.runtime/workspaces/model-artifacts" \
  "$(pwd -P)/.runtime/backups/work.json"
```

Choose a new filename each time. The command refuses to overwrite an existing
bundle. Copy the private bundle to a location covered by your backup policy.
Do not upload it with a bug report.

For a complete installation copy, stop the database too and retain its whole data
directory, workspaces and explicit configuration. Copying a running database's
files is not a consistent backup. An unsupported non-text result causes portable
export to refuse; preserve the complete offline installation instead.

## Restore into a new destination

Keep the original installation and backup. Start a second database using the
[install command](install.md), with new data and temporary directories, port
`18081`, and namespace/database both named `restored`. Keep its Massion host stopped.
From the original checkout:

```sh
node scripts/backup.ts restore-check http://127.0.0.1:18081/rpc restored restored \
  "$(pwd -P)/.runtime/restored-text" "$(pwd -P)/.runtime/backups/work.json"
node scripts/backup.ts restore http://127.0.0.1:18081/rpc restored restored \
  "$(pwd -P)/.runtime/restored-text" "$(pwd -P)/.runtime/backups/work.json"
MASSION_SURREAL_RPC=http://127.0.0.1:18081/rpc \
MASSION_SURREAL_NAMESPACE=restored MASSION_SURREAL_DATABASE=restored \
  npm start -- --restored-bundle "$(pwd -P)/.runtime/backups/work.json" \
  --restored-artifact-root "$(pwd -P)/.runtime/restored-text"
```

The destination database must be empty and the restored-text folder must not
exist. The preliminary check checks the backup against the client's size budget;
it does not prove the database server can accept it.

Keep the original bundle alongside the restored text. Both startup options are
needed to read relocated results. Open a previously accepted result and inspect
its text before relying on the restored installation. Restore grants no new
permission and does not resend unresolved work.

If restore reports an **unknown** outcome, keep the bundle, destination database,
staged text and reported restore identity. Do not repeat the restore into that
destination. Use the [recovery reference](../architecture/portable-backup.md) for
read-only inspection and supported recovery boundaries.
