import { WebApiClient } from "./api.js";
import { LiveEventConnection } from "./live.js";
import { BrowserSessionStore } from "./session.js";
import { WebConsoleStore } from "./store.js";

export const api = new WebApiClient();
export const consoleStore = new WebConsoleStore(api);
export const sessionStore = new BrowserSessionStore();
export const liveConnection = new LiveEventConnection(consoleStore);
