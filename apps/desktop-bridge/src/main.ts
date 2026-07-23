import type { BridgeAdapter } from "./bridge.js";
import { runStdioBridge, type StdioBridgeOptions } from "./stdio.js";

export async function main(adapter: BridgeAdapter, options?: StdioBridgeOptions): Promise<void> {
  await runStdioBridge(adapter, options);
}

export {
  BRIDGE_PROTOCOL,
  MAX_INPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_PENDING_REQUESTS,
  createBridge,
  JsonlFramer,
  type BridgeAdapter,
  type BridgeOptions,
} from "./bridge.js";
export { runStdioBridge, type StdioBridgeOptions } from "./stdio.js";
