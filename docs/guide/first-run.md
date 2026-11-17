# Your first conversation

What you see on first launch depends on whether Massion finds a login, a connection that is on, or a model you already chose.

```mermaid
flowchart LR
  start([Open Massion]) --> found{Login detected, connection on,<br/>or model chosen?}
  found -->|no| choose[Login choices]
  choose -->|you click one| provider[Provider's own<br/>login page]
  found -->|yes| greet[Greeting and<br/>suggestions]
  provider --> greet
  greet --> talk[Type a request]
```

| You see | What it means |
| --- | --- |
| **Login choices** | No subscription login was detected, no connection is on and no model has been chosen. Clicking one asks Massion to start that provider's own login flow. If the provider's program is not set up or cannot be verified, the login does not start and the screen says it is unavailable. When that provider's login is already present, no second login is started: the connection is turned on directly. Massion never asks you to paste credentials into the conversation. |
| **A greeting with suggestions** | A subscription login was detected, a connection is on, or a model has been chosen. You also see it after following the other-connection link on the login choices. Whether your first message is answered depends on the conditions below. |

> [!IMPORTANT]
> A detected login is used only once you act. Detection alone calls no model. The model that answers you is chosen in one of these ways, and each is recorded as your decision:
>
> - you choose it in Settings > Connections; on a subscription connection whose login is detected, that choice also turns the connection on;
> - you start a login from this screen while no connection is on;
> - you send your first message while no connection is on and exactly one subscription login is detected.
>
> Nothing is chosen for you when two logins are detected, when you added a key in Settings > Connections (that turns the connection on but chooses no model), when you removed the chosen model, or when the message was not typed by you (a scheduled briefing, or a development host running without sign-in and without live calls). The conversation then waits until you choose a model in Settings > Connections; that choice turns the chosen connection on when its login is detected, never replaces a model that is already chosen, and never reopens one you removed. A model that is chosen stays chosen, whatever logins are detected later.
>
> A login that is found does not prove the account works. A reply proves it does; a missing reply can also have other causes. Started with a host configuration file (the developer path), connections come from that file and live model calls still need the explicit flag: see [connection setup](../architecture/cli-host-connections.md). Without a usable connection, work stays blocked. It never silently switches to a demonstration model, and installation alone does not enable paid calls.

When both subscription CLIs are already logged in, this login screen is not drawn at all: the way to choose is Settings > Connections, and that choice turns the chosen connection on. A host started from a source checkout with `npm start` has no owner sign-in: no subscription connection can be made from that workbench, and a typed message gets no answer through a subscription (issue #182).

## Ask for something

Type into the conversation. What happens next depends on the size of the request.

| You ask for | Massion does | Is the result checked? |
| --- | --- | --- |
| A short question | Replies directly in the conversation | No. A direct reply is conversation, not a checked result |
| A checked result, a file, or a job with several steps | Hands it off as a task | Yes, by an independent check |

Both rows need a chosen model: without one Massion does not reply and no task starts.

Start with a small, non-sensitive request whose result you can recognize. Follow its progress, then open the result's details to see what happened.

## The first suggestions

- A suggestion can open a task picker. Selecting it sends nothing; **Assign** sends it.
- Deferring the mail suggestion connects no account.
- Its connection link opens Apps settings. That is not proof that Gmail is connected or that mail can be read.

![First launch without a detected login, showing provider login choices](images/first-run.png)

<sub>Captured from the end-to-end run with simulated login detection. No real account was opened or authenticated.</sub>

Next: [everyday use](everyday-use.md).
