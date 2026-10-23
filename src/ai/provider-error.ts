/** User-facing provider failures, without exposing request bodies or credentials. */
export function providerErrorMessage(error: unknown, provider: string | null): string {
  const label = provider === 'deepseek' ? 'DeepSeek' : provider ? provider[0]!.toUpperCase() + provider.slice(1) : 'The model provider';
  let value: any = error;
  for (let depth = 0; value && depth < 5; depth++, value = value.cause) {
    const status = value.statusCode;
    const message = typeof value.message === 'string' ? value.message : '';
    if (status === 402 || /insufficient[_ ](?:balance|quota)|credit balance|billing.*limit/i.test(message)) {
      return `${label} has insufficient API credit. Add credit to that provider account or choose another model in the chat model selector, then retry.`;
    }
    if (status === 401 || status === 403) return `${label} rejected the API credentials or access permissions. Check the provider key in Settings or choose another model, then retry.`;
    // Condensing failures are ours, with our own wording: never blame the provider for them.
    if (value.name === 'ContextCompactionError' && message) return message;
    // The ChatGPT usage-limit notice is built by the provider library and is safe to show as is.
    if (value.name === 'ChatGPTUsageLimit' && message) return message;
    if (status === 429) return `${label} is limiting requests. Wait briefly and retry, or choose another model.`;
  }
  return `${label} could not complete the response. Please retry or choose another model. If it persists, check the server diagnostics.`;
}

/** Error name, status and machine codes only (e.g. "AI_APICallError 503 server_is_overloaded"); never message text. */
export function safeErrorReason(error: unknown): string {
  const parts = new Set<string>();
  let value: any = error;
  for (let depth = 0; value && depth < 3; depth++, value = value.cause) {
    if (typeof value.name === 'string') parts.add(value.name);
    // AI SDK errors carry machine fields that explain a failure without its text.
    if (typeof value.reason === 'string' && value.reason.length <= 40) parts.add('reason:' + value.reason);
    if (typeof value.isRetryable === 'boolean') parts.add(value.isRetryable ? 'retryable' : 'not-retryable');
    if (Array.isArray(value.errors) && value.errors.length) parts.add('attempts:' + value.errors.length);
    if (typeof value.statusCode === 'number') parts.add(String(value.statusCode));
    if (typeof value.code === 'string') parts.add(value.code);
    const message = typeof value.message === 'string' ? value.message : '';
    for (const code of message.replace(/https?:\/\/\S+/g, '').match(/\b(?:[a-z]+_){1,4}[a-z]+\b|\bE[A-Z]{3,}\b|\b(?:timed? ?out|terminated|aborted|overloaded)\b/g)?.slice(0, 3) ?? []) parts.add(code);
  }
  return [...parts].join(' ').slice(0, 160);
}
