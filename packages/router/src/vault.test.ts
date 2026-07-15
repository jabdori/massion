import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CredentialVault } from "./vault.js";

describe("CredentialVault", () => {
  const altered = (value: string): string => `${value[0] === "a" ? "b" : "a"}${value.slice(1)}`;

  it("AES-256-GCM으로 secret을 roundtrip하고 ciphertext에 평문을 남기지 않는다", () => {
    const vault = new CredentialVault(randomBytes(32));
    const encrypted = vault.encrypt("sk-super-secret", "tenant:credential:1");

    expect(vault.decrypt(encrypted, "tenant:credential:1")).toBe("sk-super-secret");
    expect(JSON.stringify(encrypted)).not.toContain("sk-super-secret");
    expect(encrypted.algorithm).toBe("aes-256-gcm");
  });

  it("ciphertext·auth tag·AAD 변조를 모두 거부한다", () => {
    const vault = new CredentialVault(randomBytes(32));
    const encrypted = vault.encrypt("secret", "aad");

    expect(() => vault.decrypt({ ...encrypted, ciphertext: altered(encrypted.ciphertext) }, "aad")).toThrow();
    expect(() => vault.decrypt({ ...encrypted, authTag: altered(encrypted.authTag) }, "aad")).toThrow();
    expect(() => vault.decrypt(encrypted, "different-aad")).toThrow();
  });

  it("정확히 32-byte인 master key만 허용한다", () => {
    expect(() => new CredentialVault(randomBytes(31))).toThrow("32-byte");
    expect(() => new CredentialVault(randomBytes(33))).toThrow("32-byte");
  });
});
