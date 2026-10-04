/** Exact existing Chat Completions body. No credentials or transport behavior. */
export function renderChatCompletionsBody(model:string,instruction:string,inputReferences:readonly string[],maxTokens:number):string {
    const content = inputReferences.length === 0 ? instruction :
      `${instruction}\n\nInput references (identifiers only; their contents have not been loaded):\n${JSON.stringify(inputReferences)}`;
    const body = JSON.stringify({ model: model, messages: [{ role: 'user', content }], max_completion_tokens: maxTokens, n: 1, stream: false, store: false });
    return body;
}
