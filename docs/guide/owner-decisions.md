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

You can manage model connections, explicit execution grants and per-task budgets
through the supported settings and expanded details. There is no general
"autonomy level" that bypasses checking or permissions.

## Not available yet

The current build has no payment execution adapter, external-member delegation,
monthly budget wait/raise decision or MCP tool reconciliation journey. A matching
prototype picture is not an implemented decision. Do not submit a real payment
or assume a remote agent was contacted because a fixture depicts that state.
