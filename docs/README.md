# Documentation map

Start with the row that matches what you want to do. Each page says what is built today and what is still planned.

## Use it

| Page | What you get |
| --- | --- |
| [Guide](guide/README.md) | Install, first conversation, everyday use, your decisions, records, backup |
| [Full source-checkout reference](guide/source-checkout.md) | Every command and limit: data location, upgrades, tests, restore, connections, troubleshooting |
| [Changelog](../CHANGELOG.md) | What changed in each candidate |

## Understand it

| Page | What you get |
| --- | --- |
| [Concepts](product/concepts.md) | The ideas in plain words, with diagrams: tasks, checks, saved results, memory, improvement |
| [How Massion got here](product/story.md) | One idea through five builds, and which rule came from which failure |
| [Product charter](product/scope.md) | What Massion promises and the rules it never breaks |
| [Requirements](product/requirements.md) | The requirement ledger behind the charter |
| [Screens](product/screens/README.md) | The approved screen designs and how the app is checked against them |

## Build on it

| Page | What you get |
| --- | --- |
| [Architecture overview](architecture/README.md) | One picture of the running system and an index of every design note by topic |
| [Desktop app](../desktop/README.md) | Building and running the Electron shell |
| [Acceptance evidence](acceptance/) | What was tested, with which commands, and what remains open |
| [Contributing](../CONTRIBUTING.md) | How to propose a change |

## Decisions

The reasons behind the design, in the order they were made.

| # | Decision | In one line |
| --- | --- | --- |
| [0001](architecture/decisions/0001-product-owned-core.md) | Product-owned core, separate database | Massion, not a model vendor's SDK, owns tasks and their history; data lives in SurrealDB |
| [0002](architecture/decisions/0002-assistant-first-surface-and-independent-checks.md) | One assistant, independent checks | You enter through one assistant; results are checked independently; you decide only what cannot be undone and what changes the rules |
| [0003](architecture/decisions/0003-members-internal-teams-model-groups-and-apps.md) | Members, teams, model groups, apps | You see named members; inside, each runs a team per task; apps are programs on Massion |
| [0004](architecture/decisions/0004-member-rooms-mutual-challenge-and-discriminator.md) | Rooms and mutual challenge | Members working on one task share a room and can challenge each other; a moderator keeps it on track |
| [0005](architecture/decisions/0005-desktop-app-protocol-and-adapter-boundaries.md) | Desktop app and one protocol | The app is only a window; the core keeps running without it; five replaceable boundaries prepare a later cloud version |
| [0007](architecture/decisions/0007-member-environments-sign-in-and-permission-levels.md) | Member environments, sign-in, permission levels | Each member works in its own browser and desktop; sign-in is a form; you choose how often to be asked, and paying is always asked |
| [0009](architecture/decisions/0009-os-level-isolation.md) | OS-level isolation | Code Massion did not write runs behind an operating-system sandbox that denies by default; where it is unavailable the code does not run |
