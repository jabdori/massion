# Decisions you make

The product distinguishes two kinds of owner decision:

- Actions with lasting effects: spending, sending in your name, deleting and
  admitting another member.
- Changes to checking rules or permissions, including network and budget scope.

These rules describe the intended product boundary. The current build does not
yet have a usable path for every kind of decision.

## Available now

When a member proposal appears, you can defer it or admit the member with a name
and appearance. A member's internal workers do not become permanent members.

Installing an app opens a decision card showing what it asks to access. Review
those permissions before installing. Deferring the card installs nothing. An
update that widens permissions asks again; disabling an app narrows access.
Installing an app does not connect an external account or prove that a token is
valid. On Linux with Node 24, app code execution is unavailable because its
required sandbox is unavailable; installation is not execution evidence.

Payment and external-member adapters have explicit decision paths. A sent
request or an arrival receipt is not an accepted result. Their automated
journeys use local fixtures, not real purchases or remote delivery evidence.
A timed-out MCP write remains unknown until you record reconciliation evidence;
only then can a later distinct write proceed.

You can manage model connections, explicit execution grants and per-task budgets
through the supported settings and expanded details. Settings also shows monthly
and per-member token usage and an explicit monthly output-token limit. Work that
cannot reserve its bound waits for a budget decision. Accepting an increase can
release unchanged waiting work through the normal admission path; a new month
alone does not resume it. There is no general
"autonomy level" that bypasses checking or permissions.

## Remaining boundaries

There is no bundled production payment service or live third-party compatibility
claim. A prototype picture, installed app or fixture receipt does not establish
that an external account is connected, a purchase happened or a remote task was
accepted. Review the actual configured adapter and its evidence before relying
on an external effect.
