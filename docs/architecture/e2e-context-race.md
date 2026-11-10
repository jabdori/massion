# E2E browser context race

Wait for the existing isolated-frame resize signal before capturing the MCP page.
The original one-command retry was removed: a network-control setup failure can
close the browser, so retrying can silently continue on a blank document.
[Native loopback controls](e2e-app-frame-network.md) replace the racy injection
without changing the production isolation or the app-originated resize check.
