import { describe, expect, it } from "vitest";

import { decodeExternalJson, normalizeDeliveryId, normalizeExternalId } from "./contracts.js";

describe("외부 Surface 입력 계약", () => {
  it("bounded JSON을 재귀적으로 동결한다", () => {
    const value = decodeExternalJson(Buffer.from('{"event":{"type":"app_mention"}}'));
    expect(value).toEqual({ event: { type: "app_mention" } });
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen((value as { event: unknown }).event)).toBe(true);
  });

  it("크기·깊이·prototype key·유효하지 않은 UTF-8을 거부한다", () => {
    expect(() => decodeExternalJson(Buffer.alloc(1024 * 1024 + 1))).toThrow("byte");
    expect(() => decodeExternalJson(Buffer.from(`${"[".repeat(22)}0${"]".repeat(22)}`))).toThrow("깊이");
    expect(() => decodeExternalJson(Buffer.from('{"constructor":{}}'))).toThrow("prototype");
    expect(() => decodeExternalJson(Buffer.from([0xff]))).toThrow("UTF-8");
  });

  it("플랫폼 식별자를 표시값이 아닌 opaque 값으로 제한한다", () => {
    expect(normalizeDeliveryId("github", "b2d3f7c0-90aa-11ee-b9d1-0242ac120002")).toBe(
      "b2d3f7c0-90aa-11ee-b9d1-0242ac120002",
    );
    expect(normalizeExternalId("slack", "T012ABCDEF")).toBe("T012ABCDEF");
    expect(() => normalizeDeliveryId("github", "../../secret")).toThrow("delivery");
    expect(() => normalizeExternalId("discord", "123 456")).toThrow("식별자");
  });
});
