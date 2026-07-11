import { describe, expect, it } from "vitest";

import { ShutdownSignalController } from "./signals.js";

describe("ShutdownSignalController", () => {
  it("첫 signal은 drain하고 두 번째부터 즉시 force한다", () => {
    const controller = new ShutdownSignalController();
    expect(controller.receive()).toBe("drain");
    expect(controller.receive()).toBe("force");
    expect(controller.receive()).toBe("force");
  });
});
