import type { IntegrationOAuthCoordinator } from "./oauth.js";
import type { IntegrationStore } from "./store.js";

export function createIntegrationApplicationAdapter(store: IntegrationStore, oauth: IntegrationOAuthCoordinator) {
  return {
    connect: store.connect.bind(store),
    bindUser: store.bindUser.bind(store),
    bindChannel: store.bindChannel.bind(store),
    list: store.list.bind(store),
    listDeliveries: store.listDeliveries.bind(store),
    async startOAuth(
      context: Parameters<IntegrationStore["list"]>[0],
      input: {
        readonly platform: "slack" | "github";
        readonly redirectUri: string;
        readonly scopes: readonly string[];
      },
    ) {
      return input.platform === "slack"
        ? await oauth.startSlack(context, { redirectUri: input.redirectUri, scopes: input.scopes })
        : await oauth.startGitHub(context, { redirectUri: input.redirectUri });
    },
  };
}
