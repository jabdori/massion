# E2E browser context race

Wait for the existing isolated-frame resize signal before capturing the MCP page.
When agent-browser reports the specific network-control execution-context error,
retry that command once after a short delay. Other failures and a second failure
remain fatal. Keep the loopback restriction and isolation assertions unchanged.
