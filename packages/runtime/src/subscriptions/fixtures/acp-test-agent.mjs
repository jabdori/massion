import { Readable, Writable } from "node:stream";

import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";

let sequence = 0;
const sessions = new Set();

const app = agent({ name: "massion-acp-test-agent" })
  .onRequest(methods.agent.initialize, ({ params }) => ({
    protocolVersion: params.protocolVersion === PROTOCOL_VERSION ? params.protocolVersion : PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    agentInfo: { name: "massion-acp-test-agent", version: "1.0.0" },
  }))
  .onRequest(methods.agent.session.new, () => {
    const sessionId = `fixture-session-${String(++sequence)}`;
    sessions.add(sessionId);
    return { sessionId };
  })
  .onRequest(methods.agent.session.load, ({ params }) => {
    sessions.add(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    if (!sessions.has(params.sessionId)) throw new Error("알 수 없는 ACP test session입니다");
    const prompt = params.prompt.find((block) => block.type === "text")?.text ?? "";
    await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `fixture:${prompt}` },
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
