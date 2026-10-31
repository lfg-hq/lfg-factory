// Bounded local runtime smoke check. No accounts, settings or data are changed.
const child = Bun.spawn(['bun', 'run', 'src/index.ts'], { cwd: process.cwd(), env: process.env, stdout: 'inherit', stderr: 'inherit' });
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await Bun.sleep(200);
    if (child.exitCode !== null) throw new Error('Web process exited before readiness; check port ownership and startup diagnostics.');
    try {
      const response = await fetch('http://127.0.0.1:8080/health', { signal: AbortSignal.timeout(500) });
      ready = response.ok;
      if (ready) break;
    } catch { /* bounded startup wait */ }
  }
  if (!ready) throw new Error('Web readiness timed out.');
  await Bun.sleep(200);
  if (child.exitCode !== null) throw new Error('Web process could not bind port 8080.');
  const denied = await fetch('http://127.0.0.1:8080/api/projects/runtime-check/git/branches');
  const body = await denied.json();
  if (denied.status !== 401 || body.code !== 'AUTH_REQUIRED' || !body.correlationId || denied.headers.get('X-Correlation-ID') !== body.correlationId) throw new Error('Git authentication/correlation smoke check failed.');
  const reviews = await fetch('http://127.0.0.1:8080/api/projects/runtime-check/git/reviews');
  const reviewBody = await reviews.json();
  if (reviews.status !== 401 || reviewBody.code !== 'AUTH_REQUIRED' || !reviewBody.correlationId) throw new Error('Private review authentication check failed.');
  console.log('Web smoke check passed: health, Git and saved-review correlated authentication failures. No live-provider workflow claimed.');
} finally {
  child.kill('SIGTERM');
  await child.exited;
}
