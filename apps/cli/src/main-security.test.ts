import { describe, expect, it } from "vitest";

import { assertSecretTransportEndpoint } from "./main.js";

describe("CLI secret 전송 경계", () => {
  it("외부 HTTPS와 loopback HTTP만 허용하고 평문 원격·URL 자격 증명은 거부한다", () => {
    expect(() => assertSecretTransportEndpoint("https://massion.example.com")).not.toThrow();
    expect(() => assertSecretTransportEndpoint("http://127.0.0.1:7331")).not.toThrow();
    expect(() => assertSecretTransportEndpoint("http://[::1]:7331")).not.toThrow();
    expect(() => assertSecretTransportEndpoint("http://localhost:7331")).not.toThrow();
    expect(() => assertSecretTransportEndpoint("http://massion.example.com")).toThrow(/HTTPS|loopback/u);
    expect(() => assertSecretTransportEndpoint("https://user:password@massion.example.com")).toThrow("자격 증명");
  });
});
