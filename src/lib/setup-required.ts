/** Deliberately deny all production routes until real admin/device auth and DB adapters exist. */
export function setupRequired(): Response {
  return Response.json({ error: { code: 'SETUP_REQUIRED', message: 'This is a local prototype. Authentication, device enrollment and production storage are not connected.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
}
