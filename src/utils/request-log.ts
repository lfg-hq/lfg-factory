// Structured adapter for the existing stdout request logger. Platform collection
// owns rotation; no unbounded application log files or raw request URLs/bodies.
export async function loggedRequest(request: Request, event: string, run: (requestId: string) => Promise<Response>): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = performance.now();
  const write = (transition: string, status?: number, errorCode?: string) => console.info(JSON.stringify({
    timestamp: new Date().toISOString(), level: status && status >= 500 ? "error" : errorCode || (status && status >= 400) ? "warn" : "info",
    service: "venture", event, requestId, transition,
    outcome: transition === "cancelled" ? "cancelled" : errorCode ? (status && status >= 400 && status < 500 ? "denied" : "failed") : status ? "success" : "pending",
    durationMs: Math.round(performance.now() - started),
    method: request.method, ...(event.includes("google") ? { provider: "google", retryCount: 0 } : {}),
    ...(status ? { status } : {}), ...(errorCode ? { errorCode } : {}),
  }));
  write("started");
  let response: Response;
  try {
    response = await run(requestId);
  } catch {
    response = Response.json({ error: "Request failed. Please retry; contact support with this correlation ID if it continues.", code: "INTERNAL_ERROR", requestId }, { status: 500 });
  }
  const failureRedirect = response.headers.get("location")?.includes("auth=failed") || response.headers.get("location")?.includes("error=");
  const code = response.headers.get("X-Error-Code") || (response.status >= 400 ? `HTTP_${response.status}` : failureRedirect ? "OAUTH_NOT_COMPLETED" : undefined);
  write(code === "OAUTH_CANCELLED" ? "cancelled" : code ? "failed" : "completed", response.status, code);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("X-Request-ID", requestId);
  return response;
}

export function ventureError(requestId: string, status: number, code: string, error: string) {
  return Response.json({ error, code, requestId }, { status, headers: { "X-Error-Code": code } });
}
