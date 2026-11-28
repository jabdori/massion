import { CONNECTION_ACTIVATION_ID, activationCommandId, activationFingerprint, activationState, applyActivation } from '../../src/connection-activation.ts';
import { AssistantConversation, assistantTurnId, ownerMessageId } from '../../src/assistant-conversation.ts';
import { InMemoryStore } from '../../src/storage.ts';
import type { PortableJournal } from '../../src/storage.ts';
import type { Mission } from '../../src/domain.ts';

/** The owner's command that appended the message every journal built here cites, and the author the old send path dispatched it as (OWNER in src/assistant-service.ts at f6f6c95). */
export const FIRST_MESSAGE_COMMAND_ID = 'legacy-1', OWNER = 'local-owner';

/**
 * The journal the in-send path wrote from 070a6780 to 9f323fcc (read at f6f6c95: src/assistant-service.ts:178-192 and src/connection-workbench.ts:293-305): the owner's message with a pending turn on the candidate route, dispatched by `author`, then the first-message turn-on whose command ID derives from that message's command and whose route is that candidate's profile.
 * `origin` is what the stored message says about itself; the activation always claims the owner typed it. `thread` is the conversation the message lives in ('' is the Representative's).
 */
export async function firstMessageJournal(options: { origin?: 'owner-typed' | 'imported'; author?: string; thread?: string } = {}): Promise<PortableJournal<Mission>> {
  const store = new InMemoryStore<Mission>(), author = options.author ?? OWNER, messageId = ownerMessageId(FIRST_MESSAGE_COMMAND_ID), at = 1000;
  const profile = { profileId: 'profile:claude', configHash: 'a'.repeat(64), model: 'claude-sonnet-5-5', outputTokenCap: 4 };
  const turn = { status: 'pending' as const, id: assistantTurnId(messageId), route: { profileId: profile.profileId, configHash: profile.configHash, provider: 'claude-code-cli', model: profile.model, mode: 'live' as const, outputTokenCap: profile.outputTokenCap }, ownership: { hostSessionId: 'old-host', dispatchId: 'old-dispatch', startedAt: at, deadlineAt: at + 60000 }, requestHash: 'a'.repeat(64), contextMessageIds: [] };
  await new AssistantConversation(store, [{ id: author, roles: ['owner'] }], () => at, options.thread ?? '').dispatch({ segment: 1, commandId: FIRST_MESSAGE_COMMAND_ID, expectedRevision: 0, actorId: author, command: { type: 'open-assistant-segment', recordMessageTime: true, segment: 1, previous: null, messageId, origin: options.origin ?? 'owner-typed', text: 'Earlier message', turn } });
  const command = { kind: 'turn-on' as const, commandId: activationCommandId(FIRST_MESSAGE_COMMAND_ID, 'first-message'), connectionId: 'c-claude', way: 'first-message' as const, at, messageId, messageOrigin: 'owner-typed' as const, detectedLogins: ['c-claude'], route: { ...profile, intakeMissionId: 'assistant-intake' } };
  const applied = applyActivation(activationState(undefined), command);
  await store.commit({ id: CONNECTION_ACTIVATION_ID, commandId: command.commandId, fingerprint: activationFingerprint(command), expectedRevision: 0, value: applied.value, events: applied.events, outbox: [] } as unknown as Parameters<typeof store.commit>[0]);
  const operations = [...store.inspect()];
  return { schemaVersion: 2, head: operations.length, operations };
}
