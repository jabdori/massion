/** Exact Chat Completions bodies. No credentials or transport behavior. */
export type ChatDialect='openai'|'zai';
export const CHAT_DIALECTS:readonly ChatDialect[]=['openai','zai'];
export function renderChatCompletionsBody(model:string,instruction:string,inputReferences:readonly string[],maxTokens:number,dialect:ChatDialect='openai'):string {
    const content = inputReferences.length === 0 ? instruction :
      `${instruction}\n\nInput references (identifiers only; their contents have not been loaded):\n${JSON.stringify(inputReferences)}`;
    const messages = [{ role: 'user', content }];
    // Z.ai ignores max_completion_tokens (observed 2026-11-04: cap 16 produced 1,042 tokens) and counts
    // reasoning tokens toward max_tokens; low effort keeps the visible answer inside the bounded cap.
    if (dialect === 'zai') return JSON.stringify({ model, messages, max_tokens: maxTokens, reasoning_effort: 'low', n: 1, stream: false });
    return JSON.stringify({ model, messages, max_completion_tokens: maxTokens, n: 1, stream: false, store: false });
}
