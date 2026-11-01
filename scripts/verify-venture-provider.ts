// Explicit opt-in operator smoke command, never startup or an automatic retry.
// Uses real platform credentials and real provider/research calls; no fixtures.
import { generateText } from 'ai';
import { DEFAULT_MODEL_KEY, getModel, getProviderName, getProviderModel } from '../src/ai/provider.ts';
import { env } from '../src/config/env.ts';
import { createWebResearchTools } from '../src/ai/tools/agent-tools.ts';
import { publicUrl, readPublicUrl } from '../src/services/venture-public-url.ts';
import { ventureLog } from '../src/utils/request-log.ts';
const requestId = crypto.randomUUID(), started = performance.now();
const signal = AbortSignal.timeout(20000);
const details = { provider: getProviderName(DEFAULT_MODEL_KEY), model: getProviderModel(DEFAULT_MODEL_KEY) };
ventureLog('venture.live_smoke.started', requestId, started, 'pending', details);
try {
  const model = getModel(DEFAULT_MODEL_KEY, undefined, { allowEnvFallback: true });
  if (!env.EXA_API_KEY) throw new Error('SEARCH_NOT_CONFIGURED');
  const result = await generateText({ model, prompt: 'Ask one concise question about the customer for a new small business idea. Do not include personal data.', maxOutputTokens: 80, maxRetries: 0, abortSignal: signal });
  if (!result.text.trim()) throw new Error('EMPTY_RESPONSE');
  const tools = createWebResearchTools({ signal, readPublicUrl });
  const search: any = await tools.webSearch.execute!({ query: 'US Census small business statistics', num_results: 1 }, { toolCallId: requestId, messages: [], abortSignal: signal });
  if (search.error || !search.results?.length) throw new Error('RESEARCH_FAILED');
  const first = search.results[0]; await publicUrl(first.url);
  await readPublicUrl(first.url, 1000, signal);
  ventureLog('venture.live_smoke.completed', requestId, started, 'success', { ...details, providerRequestId: result.response.id, researchSourceCount: 1 });
} catch {
  ventureLog('venture.live_smoke.failed', requestId, started, 'failed', { ...details, errorCode: 'LIVE_PROVIDER_OR_RESEARCH_UNAVAILABLE', message: 'Configure the model provider API key and EXA_API_KEY in .env; check provider availability, then rerun explicitly.' });
  process.exitCode = 1;
}
