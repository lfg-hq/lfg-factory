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
    if (status === 429) return `${label} is limiting requests. Wait briefly and retry, or choose another model.`;
  }
  return `${label} could not complete the response. Please retry or choose another model. If it persists, check the server diagnostics.`;
}
