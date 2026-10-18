import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.ts';
import { connectRealtimeVoice } from '../../services/voice-realtime.ts';
import { connectDictation, transcribeDictation } from '../../services/dictation.ts';
import { generateVoiceSpeech } from '../../services/voice-speech.ts';

type VoiceEnv = { Variables: { user: { id: string } } };
const input = z.object({ text: z.string().trim().min(1).max(1200), projectId: z.string().uuid().nullable().optional() });

export function createVoiceRoutes(deps: {
  auth: MiddlewareHandler<any>;
  key: (userId: string, projectId?: string | null) => Promise<string | null>;
  speech: typeof generateVoiceSpeech;
  realtime?: typeof connectRealtimeVoice;
  dictation?: typeof connectDictation;
  transcribe?: typeof transcribeDictation;
}) {
  const router = new Hono<VoiceEnv>();
  router.use('*', deps.auth);
  router.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  router.use('*', async (c, next) => bodyLimit({ maxSize: c.req.path.endsWith('/dictation/transcribe') ? 12 * 1024 * 1024 : 65536 })(c, next));
  router.get('/', async c => {
    const projectId = c.req.query('projectId');
    if (projectId && !z.string().uuid().safeParse(projectId).success) return c.json({error:'Invalid project'},400);
    const key = await deps.key(c.get('user').id, projectId);
    return c.json({ natural: !!key, reason: key ? null : 'Voice requires a server OpenAI API key and permission to use API keys.' });
  });
  const active = new Map<string, number>();
  const dictationInput = z.object({
    projectId: z.string().uuid().nullable().optional(),
    prompt: z.string().trim().max(800).optional(),
    keywords: z.array(z.string().trim().min(1).max(80).regex(/^[^<>\r\n]+$/)).max(30).optional(),
  });
  for (const kind of ['session', 'transcribe'] as const) {
    router.post(`/dictation/${kind}`, async c => {
      let file: File | undefined;
      let data: unknown;
      try {
        if (kind === 'session') data = await c.req.json();
        else {
          const form = await c.req.formData();
          const audio = form.get('audio');
          if (!(audio instanceof File) || !audio.size || audio.size > 10 * 1024 * 1024 ||
              ! /^(audio\/(webm|mp4|ogg|wav|mpeg)|video\/(webm|mp4))(;.*)?$/.test(audio.type)) return c.json({error:'Unsupported or oversized recording.'},400);
          file = audio;
          data = JSON.parse(String(form.get('context') || '{}'));
        }
      } catch { return c.json({error:'Invalid dictation request.'},400); }
      const parsed = (kind === 'session' ? dictationInput.extend({sdp:z.string().min(20).max(60000).startsWith('v=0')}) : dictationInput).safeParse(data);
      if (!parsed.success) return c.json({error:'Invalid dictation request.'},400);
      const userId = c.get('user').id;
      const key = await deps.key(userId, parsed.data.projectId);
      if (!key) return c.json({error:'Dictation requires a server OpenAI API key and permission to use it.'},409);
      if ((active.get(userId) || 0) >= 2) return c.json({error:'Another audio request is running. Please retry shortly.'},429);
      active.set(userId, (active.get(userId) || 0) + 1);
      const {prompt, keywords} = parsed.data;
      const context = {...(prompt ? {prompt} : {}), ...(keywords?.length ? {keywords} : {})};
      try {
        const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(kind === 'session' ? 25000 : 60000)]);
        if (kind === 'session') {
          const sdp = await (deps.dictation || connectDictation)((parsed.data as {sdp:string}).sdp,key,signal,context);
          return c.body(sdp,200,{'Content-Type':'application/sdp'});
        }
        return c.json({text:await (deps.transcribe || transcribeDictation)(file!,key,signal,context)});
      } catch (error:any) {
        console.warn(JSON.stringify({component:'dictation',event:'failed',kind,status:error?.statusCode}));
        return c.json({error:[401,403].includes(error?.statusCode)
          ? 'OpenAI denied transcription access. Ask an administrator to check the server key and model access.'
          : 'Transcription could not finish. Your recording is available to retry.'},502);
      } finally {
        const n = (active.get(userId) || 1) - 1;
        if (n) active.set(userId,n); else active.delete(userId);
      }
    });
  }
  router.post('/session', async c => {
    if (!c.req.header('Content-Type')?.includes('application/json')) return c.json({error:'JSON required'},415);
    const parsed = z.object({sdp:z.string().min(20).max(60000).startsWith('v=0'),projectId:z.string().uuid().nullable().optional()}).safeParse(await c.req.json().catch(()=>null));
    if(!parsed.success) return c.json({error:'Invalid voice connection request'},400);
    const userId=c.get('user').id;
    const key=await deps.key(userId,parsed.data.projectId);
    if(!key) return c.json({error:'Voice is unavailable. Ask an administrator to check voice access and the server API key.'},409);
    if((active.get(userId)||0)>=2) return c.json({error:'A voice connection is already starting. Please wait.'},429);
    active.set(userId,(active.get(userId)||0)+1);
    const requestId=crypto.randomUUID();
    try {
      const sdp=await (deps.realtime || connectRealtimeVoice)(parsed.data.sdp,key,AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(25000)]));
      return c.body(sdp,200,{'Content-Type':'application/sdp','Cache-Control':'no-store'});
    } catch(error:any) {
      console.warn(JSON.stringify({component:'voice',event:'realtime_connection_failed',requestId,status:error?.statusCode}));
      return c.json({error:[401,403].includes(error?.statusCode)
        ? 'OpenAI denied voice access. Ask an administrator to check the server API key and Realtime permissions.'
        : 'Could not connect voice. Please try again.',requestId},502);
    } finally { const n=(active.get(userId)||1)-1;if(n)active.set(userId,n);else active.delete(userId); }
  });
  router.post('/', async c => {
    if (!c.req.header('Content-Type')?.includes('application/json')) return c.json({error:'JSON required'},415);
    const parsed = input.safeParse(await c.req.json().catch(()=>null));
    if (!parsed.success) return c.json({error:'Speech text must be between 1 and 1200 characters, with a valid project ID.'},400);
    const userId = c.get('user').id;
    const key = await deps.key(userId, parsed.data.projectId);
    if (!key) return c.json({code:'voice_key_missing',error:'Voice requires a server OpenAI API key and permission to use API keys.'},409);
    if ((active.get(userId) || 0) >= 2) return c.json({error:'A voice request is already running. Please retry.'},429);
    active.set(userId, (active.get(userId) || 0) + 1);
    const requestId = crypto.randomUUID(), started = Date.now();
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(25000)]);
    console.info(JSON.stringify({component:'voice',event:'started',requestId,model:'gpt-4o-mini-tts'}));
    try {
      const audio = await deps.speech(parsed.data.text,key,signal);
      console.info(JSON.stringify({component:'voice',event:'completed',requestId,durationMs:Date.now()-started}));
      return new Response(audio,{headers:{'Content-Type':'audio/mpeg','Cache-Control':'no-store'}});
    } catch (error: any) {
      console.warn(JSON.stringify({component:'voice',event:'failed',requestId,status:error?.statusCode,durationMs:Date.now()-started}));
      if (!signal.aborted && [401,403].includes(error?.statusCode)) {
        const unauthorized = error.statusCode === 401;
        return c.json({code: unauthorized ? 'voice_key_rejected' : 'voice_access_denied',
          error: unauthorized
            ? 'OpenAI rejected the server voice API key. Ask an administrator to update OPENAI_API_KEY and restart the app.'
            : 'OpenAI denied speech access. Ask an administrator to check the server API key permissions and account access.', requestId},409);
      }
      return c.json({error: signal.aborted ? 'Voice request timed out or was cancelled. Please retry.' : 'Natural voice could not play. Ask an administrator to check the server OpenAI API key and credit, then retry.', requestId},502);
    } finally { const remaining = (active.get(userId) || 1) - 1; if (remaining) active.set(userId, remaining); else active.delete(userId); }
  });
  return router;
}

export async function resolveVoiceEnvironmentKey(
  userId: string, projectId: string | null | undefined,
  accessFor: (userId: string, projectId?: string | null) => Promise<{canUseKey: boolean}>,
  environmentKey: () => string | undefined,
): Promise<string | null> {
  const access = await accessFor(userId, projectId);
  if (!access.canUseKey) return null;
  return environmentKey()?.trim() || null;
}

export default createVoiceRoutes({auth:requireAuth, speech:generateVoiceSpeech, key:async(userId,projectId)=>{
  const { userLlmAccess } = await import('../../services/llm-access.ts');
  const { env } = await import('../../config/env.ts');
  return resolveVoiceEnvironmentKey(userId, projectId, userLlmAccess, () => env.OPENAI_API_KEY);
}});
