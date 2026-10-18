import { providerErrorMessage } from '../ai/provider-error.ts';

export async function generateVoiceSpeech(text: string, key: string, signal: AbortSignal, request: typeof fetch = fetch) {
  const response = await request('https://api.openai.com/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini-tts', voice: 'marin', input: text, response_format: 'mp3',
      instructions: 'Speak naturally as a warm, calm conversational assistant. Use relaxed phrasing, varied intonation, and short natural pauses. Avoid an announcer voice, exaggerated enthusiasm, or a robotic cadence. Read only the supplied text, without adding words.' }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error(providerErrorMessage({statusCode:response.status}, 'openai')), {statusCode:response.status});
  }
  return await response.arrayBuffer();
}
