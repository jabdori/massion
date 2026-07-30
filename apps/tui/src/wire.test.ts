import { expect, it } from "vitest";

import { testSnapshot } from "./state.test.js";
import { decodeSnapshot } from "./wire.js";

it("협업 node 공개 계약을 fail-closed로 검증한다", () => {
  const persistentNode = testSnapshot.nodes[0];
  const workNode = {
    ...persistentNode,
    nodeId: "node-worker",
    handle: "worker",
    parentHandle: "representative",
    scope: "work",
    workId: "work-1",
  } as const;
  const decodeNodes = (nodes: readonly unknown[]) => decodeSnapshot({ ...testSnapshot, nodes });

  expect(decodeNodes([workNode, persistentNode]).nodes[0]).toMatchObject({
    nodeId: "node-worker",
    parentHandle: "representative",
    scope: "work",
    workId: "work-1",
  });
  expect(() => decodeNodes([persistentNode, { ...workNode, workId: undefined }])).toThrow(/workId/u);
  expect(() => decodeNodes([{ ...persistentNode, workId: "work-1" }])).toThrow(/persistent/u);
  expect(() => decodeNodes([persistentNode, { ...workNode, currentWorkId: "work-2" }])).toThrow(/currentWorkId/u);
  expect(() => decodeNodes([{ ...persistentNode, parentHandle: "representative" }])).toThrow(/자기/u);
  expect(() => decodeNodes([persistentNode, { ...workNode, parentHandle: "missing" }])).toThrow(/parentHandle/u);
  expect(() =>
    decodeNodes([
      { ...persistentNode, parentHandle: "worker" },
      { ...workNode, parentHandle: "representative" },
    ]),
  ).toThrow(/cycle/u);
  expect(() => decodeNodes([persistentNode, { ...workNode, nodeId: persistentNode.nodeId }])).toThrow(/nodeId.*중복/u);
  expect(() => decodeNodes([persistentNode, { ...workNode, handle: persistentNode.handle }])).toThrow(/handle.*중복/u);
  expect(() => decodeNodes([{ ...persistentNode, nodeId: "" }])).toThrow(/nodeId/u);
  expect(() => decodeNodes([{ ...persistentNode, scope: "core" }])).toThrow(/scope/u);
  expect(() => decodeNodes([{ ...persistentNode, token: "secret" }])).toThrow(/알 수 없는/u);
});
