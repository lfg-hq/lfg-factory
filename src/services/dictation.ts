/** Transcription only: no assistant response, tools, or spoken output. */
export type DictationContext = { prompt?: string; keywords?: string[] };
export function dictationSession(context: DictationContext = {}) {
  return { type: 'transcription', audio: { input: {
    noise_reduction: { type: 'near_field' },
    transcription: { model: 'gpt-live-transcribe', delay: 'medium', ...context },
    turn_detection: null,
  } } };
}
export async function connectDictation(sdp: string, key: string, signal: AbortSignal, context: DictationContext = {}, request: typeof fetch = fetch) {
  const form = new FormData();
  form.set('sdp', sdp); form.set('session', JSON.stringify(dictationSession(context)));
  const response = await request('https://api.openai.com/v1/realtime/calls', {
    method: 'POST', headers: {Authorization: `Bearer ${key}`}, body: form, signal,
  });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Dictation connection failed'), {statusCode: response.status}); }
  return response.text();
}
export async function transcribeDictation(file: File, key: string, signal: AbortSignal, context: DictationContext = {}, request: typeof fetch = fetch) {
  const form = new FormData();
  form.set('file', file); form.set('model', 'gpt-transcribe');
  if (context.prompt) form.set('prompt', context.prompt);
  for (const keyword of context.keywords || []) form.append('keywords[]', keyword);
  const response = await request('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: {Authorization: `Bearer ${key}`}, body: form, signal,
  });
  if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Dictation transcription failed'), {statusCode: response.status}); }
  const data = await response.json() as {text?: unknown};
  if (typeof data.text !== 'string') throw new Error('Invalid transcript');
  return data.text.trim();
}
