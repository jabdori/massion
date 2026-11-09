# Troubleshooting

| What you see | What to check |
| --- | --- |
| The app cannot start | Use Node 24.19.0 or newer 24.x and SurrealDB 3.3.0. Reinstall the locked development tools. |
| The workbench address does not open | Start the database first and check the address printed by the host. A closed terminal may have stopped it. |
| A port is already in use | Stop its owner or choose another port. Do not terminate an unrelated process just to make room. |
| My old data is missing | Check the original working folder, database address and database name. A fresh database does not move the old data. |
| A login is detected but work is blocked | Local login detection is separate from a configured model route and execution permission. Review the explicit connection setup. |
| An app is installed but will not open on Linux | Node 24 on Linux cannot provide the required app-code sandbox. Installation alone does not make handlers available. |
| Work failed its check | Inspect the failed evidence. Use a new correction task for a known rejection; keep the original. |
| The outcome is unknown after a restart | Preserve the original entry and inspect evidence. Restart never proves that an external request failed or makes resending safe. |
| Shutdown says unsettled | Keep the data, stop further host admission and inspect the original operation. Do not replay to see whether it works. |
| The host refuses a newer or damaged database | Keep it intact and use a compatible host or a separate verified backup. Never edit its version marker to bypass the refusal. |
| Backup or restore refuses a destination | Use canonical absolute paths, a new backup filename, a fresh empty database and a new text folder. Preserve the originals. |
| Restored result text is unavailable | Start with both restore options, the retained backup bundle and the exact restored-text folder. |

For a useful bug report, include the Node and SurrealDB versions, the command you
ran, its exit status and the non-sensitive error text. Explain the visible state
and whether the outcome was known or unknown. Do not attach credentials, private
backup contents or unredacted provider responses.

The [development README](../../README.md#troubleshooting) has additional operational
diagnostics. The [backup reference](../architecture/portable-backup.md) explains
what can be recovered without replaying effects.
