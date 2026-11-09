/** Frozen /api/v1 error envelope (contract section 8). Always no-store. */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  opts: { retryable?: boolean; retryAfterMs?: number } = {},
): Response {
  const error: Record<string, unknown> = { code, message, retryable: opts.retryable === true };
  if (opts.retryAfterMs !== undefined) error.retryAfterMs = opts.retryAfterMs;
  return Response.json(
    { error },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

export function jsonResponse(status: number, body: unknown, extraHeaders?: Headers): Response {
  const headers = new Headers(extraHeaders);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}
