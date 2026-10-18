/** Bounded, per-user auth-path probe. Never returns credentials or claims model health. */
export type ConnectionCheck = { status: 'ready' | 'reconnect' | 'unavailable' | 'checking'; message: string };
export function createConnectionChecker(resolveAccess: (userId: string) => Promise<string>, timeoutMs = 8000, cacheMs = 10000) {
  const checks = new Map<string, {promise: Promise<ConnectionCheck>; expires: number}>();
  return async (userId: string): Promise<ConnectionCheck> => {
    let entry = checks.get(userId);
    if (!entry || entry.expires < Date.now()) {
      const promise = Promise.resolve().then(() => resolveAccess(userId)).then<ConnectionCheck>(() => ({status:'ready', message:'ChatGPT access is available. You can retry your message.'})).catch((error): ConnectionCheck => {
        const message = error instanceof Error ? error.message : '';
        return /not connected|reconnect|could not be refreshed/i.test(message)
          ? {status:'reconnect',message:'ChatGPT needs to be reconnected in Settings.'}
          : {status:'unavailable',message:'The ChatGPT authentication service is unavailable. Try checking again shortly.'};
      });
      entry = {promise, expires:Infinity}; checks.set(userId,entry);
      const current = entry;
      void promise.then(() => {current.expires=Date.now()+cacheMs;setTimeout(()=>{if(checks.get(userId)===current)checks.delete(userId);},cacheMs).unref?.();});
    }
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([entry.promise, new Promise<ConnectionCheck>(resolve => {
        timer=setTimeout(()=>resolve({status:'checking',message:'ChatGPT access is still being checked. Check again shortly.'}),timeoutMs);
      })]);
    } finally { clearTimeout(timer!); }
  };
}
