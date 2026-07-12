import { Readable, Writable } from "node:stream";

import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

let sequence = 0;
const sessions = new Set();
let fileSystemAvailable = false;

const app = agent({ name: "massion-acp-test-agent" })
  .onRequest(methods.agent.initialize, ({ params }) => {
    fileSystemAvailable = params.clientCapabilities.fs?.readTextFile === true;
    return {
      protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: "massion-acp-test-agent", version: "1.0.0" },
    };
  })
  .onRequest(methods.agent.session.new, () => {
    const sessionId = `fixture-session-${String(++sequence)}`;
    sessions.add(sessionId);
    return {
      sessionId,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fixture-default",
          options: [
            { value: "fixture-default", name: "Fixture Default" },
            { value: "fixture-model", name: "Fixture Model" },
          ],
        },
      ],
    };
  })
  .onRequest(methods.agent.session.load, ({ params }) => {
    sessions.add(params.sessionId);
    return {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fixture-default",
          options: [
            { value: "fixture-default", name: "Fixture Default" },
            { value: "fixture-model", name: "Fixture Model" },
          ],
        },
      ],
    };
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    if (!sessions.has(params.sessionId) || params.configId !== "model" || params.value !== "fixture-model") {
      throw new Error("지원하지 않는 fixture model입니다");
    }
    return { configOptions: [] };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error("알 수 없는 ACP test session입니다");
    const prompt = params.prompt.find((block) => block.type === "text")?.text ?? "";
    let responseText = `fixture:${prompt}`;
    if (prompt === "output-limit") responseText = "x".repeat(64 * 1024 + 1);
    if (prompt === "fs-read") {
      if (!fileSystemAvailable) throw new Error("ACP file system capability가 없습니다");
      const response = await client.request(methods.client.fs.readTextFile, {
        sessionId: params.sessionId,
        path: "/tmp/fixture.txt",
      });
      responseText = `fixture-fs:${response.content}`;
    }
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: responseText },
      },
    });
    return {
      stopReason: "end_turn",
      _meta: { quota: { inputTokens: 2, outputTokens: 3 } },
    };
  })
  .onNotification(methods.agent.session.cancel, () => {});

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
const connection = app.connect(ndJsonStream(output, input));
await connection.closed;
