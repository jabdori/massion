# Your records and files

A conversation retains what you said and the replies you received. An accepted
Record retains a checked result and the exact evidence used to accept it. A later
correction creates a new history entry; it does not rewrite the original result.

The results shelf collects available results. Open a result and its details to
inspect the request, steps and check. Keep the stored evidence when moving an
installation; the conversation alone cannot replace the accepted files.

For the persistent web setup in this guide:

| What you keep | Where it lives |
| --- | --- |
| Conversation, work history, members and settings | `.runtime/database`, using the database named `massion` |
| Workspaces and sealed result text | `.runtime/workspaces/` |
| Your chosen connection configuration | The host configuration file you supplied |
| A portable backup | The private file you choose at export |

These paths are relative to the folder where you started the web host. The
desktop app uses its own private app-data directory for its host and workspaces;
see [desktop setup](../../desktop/README.md#run). The database remains the separate
service you configured.

Credentials remain in the source you explicitly configured. They are not included
in a portable backup. Backups may still contain private conversations and result
text: keep them private.

The disposable test/demo launcher deletes its database at exit. Use the
[persistent installation](install.md) for everyday data and follow
[backup and restore](backup-restore.md) before moving or upgrading it.
