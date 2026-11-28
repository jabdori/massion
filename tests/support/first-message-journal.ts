import { CONNECTION_ACTIVATION_ID, activationCommandId, activationFingerprint, activationState, applyActivation } from '../../src/connection-activation.ts';
import { AssistantConversation, assistantTurnId, ownerMessageId } from '../../src/assistant-conversation.ts';
import { InMemoryStore } from '../../src/storage.ts';
import type { PortableJournal } from '../../src/storage.ts';
import type { Mission } from '../../src/domain.ts';

/** The owner's command that appended the message every journal built here cites. */
export const FIRST_MESSAGE_COMMAND_ID = 'legacy-1';

/**
 * The first-message turn-on the product wrote from 8ebec71b to 9f323fcc: the owner's message in the Representative conversation, then an activation whose command ID derives from that message's command.
 * `origin` is what the stored message says about itself; the activation always claims the owner typed it.
 */
export async function firstMessageJournal(origin: 'owner-typed' | 'imported' = 'owner-typed'): Promise<PortableJournal<Mission>> {
  const store = new InMemoryStore<Mission>(), messageId = ownerMessageId(FIRST_MESSAGE_COMMAND_ID);
  const route = { model: 'claude-sonnet-5-5', profileId: 'profile:claude', configHash: 'a'.repeat(64), outputTokenCap: 4, intakeMissionId: 'intake' };
  await new AssistantConversation(store, [{ id: 'local-owner', roles: ['owner'] }], () => 1000).dispatch({ segment: 1, commandId: FIRST_MESSAGE_COMMAND_ID, expectedRevision: 0, actorId: 'local-owner', command: { type: 'open-assistant-segment', recordMessageTime: true, segment: 1, previous: null, messageId, origin, text: 'Earlier message', turn: { status: 'not_started', id: assistantTurnId(messageId), diagnostics: [{ code: 'assistant_route_missing', message: 'No Representative route is set.' }] } } });
  const command = { kind: 'turn-on' as const, commandId: activationCommandId(FIRST_MESSAGE_COMMAND_ID, 'first-message'), connectionId: 'c-claude', way: 'first-message' as const, at: 1, messageId, messageOrigin: 'owner-typed' as const, detectedLogins: ['c-claude'], route };
  const applied = applyActivation(activationState(undefined), command);
  await store.commit({ id: CONNECTION_ACTIVATION_ID, commandId: command.commandId, fingerprint: activationFingerprint(command), expectedRevision: 0, value: applied.value, events: applied.events, outbox: [] } as unknown as Parameters<typeof store.commit>[0]);
  const operations = [...store.inspect()];
  return { schemaVersion: 2, head: operations.length, operations };
}
