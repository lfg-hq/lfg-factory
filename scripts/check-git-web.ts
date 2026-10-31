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
  for (const [method, path] of [['POST', 'pull-requests/1/merge'], ['DELETE', 'branches']] as const) {
    const response = await fetch(`http://127.0.0.1:8080/api/projects/runtime-check/git/${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const error = await response.json();
    if (response.status !== 401 || error.code !== 'AUTH_REQUIRED' || !error.correlationId) throw new Error('Private mutation authentication check failed.');
  }
  // Invalid login probes the actual database-backed auth handler; creates no account/session.
  const login = await fetch('http://127.0.0.1:8080/api/auth/sign-in/email', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8080' }, body: JSON.stringify({ email: 'runtime-capability-check@invalid.example', password: crypto.randomUUID() }) });
  if (login.status !== 401) throw new Error(`Database-backed authentication probe returned ${login.status}; inspect runtime configuration.`);
  console.log('Web smoke check passed: health, database-backed authentication and correlated Git/review/mutation denial. No live-provider workflow claimed.');
} finally {
  child.kill('SIGTERM');
  await child.exited;
}
