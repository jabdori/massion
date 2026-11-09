# Empty-conversation CI regression

CI [run 42534455306](https://github.com/jabdori/massion/actions/runs/42534455306)
failed at head `668d593`: B1-signin in both themes timed out at the unchanged
`agent-browser wait #chat-log` (5,000ms). The same focused runner command failed
locally before the layout correction; [raw reproduction](ci-signin-reproduction.json).

The node existed and JavaScript had reached `workbenchReady`. Its measured state
was `display:flex`, `flex-grow:0`, height **0px**, with no messages, inside a
**752px** scroll viewport. E3b introduced `.chat-scroll` and removed the old
`#page-chat .chat-log { flex:1 }` sizing. A genuinely empty conversation therefore
collapsed even though the unavailable sign-in page was already a documented gap.

The correction makes `.chat-scroll` a flex column and lets `.chat-log` flex into
its available viewport. This restores the old empty-state sizing in the new
wrapper. No phantom greeting, sign-in page, login action, timeout increase or
infrastructure-error waiver is introduced. B1-signin keeps its original fixture
readiness selector and capability-gap annotation.

After the correction, the headless browser regression measures a **710px** empty
log (`flex-grow:1`, zero children) inside the same **752px** viewport in both
themes. [Measurements](visual-gate.json). The same regression also verifies that
normal populated conversations, the eight visual-gate cases and visible-modal
shortcut ownership still work.

The workflow's capture command is reproduced locally, including all 75 states
and both system themes, using the installed agent-browser **0.41.2**:

```sh
UI_CONTRACTS_BLOCKING=0 node scripts/ui-contracts/run.mjs
```

Local Node is **24.21.0**, within the repository's supported 24.x range; CI pins
24.19.0 on Ubuntu. The local run uses the same runner command and browser CLI on
macOS. The original 5s readiness wait and `infrastructure errors always fail`
behavior are unchanged. Full results are recorded in [ci-ui-contracts.json](ci-ui-contracts.json).

The workflow's preceding harness and copy checks also pass:

```sh
node --test tests/ui-contract-*.test.ts tests/ui-copy-lint.test.ts
node scripts/check.mjs
```

The exact capture command completed with **exit code 0**, **150/150 captured states**
and **zero infrastructure errors**. [Execution receipt](ci-execution.json).
B1-signin retains its documented sign-in capability gap in both themes.
