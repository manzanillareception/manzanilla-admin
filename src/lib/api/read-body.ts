import { errorResponse } from '../auth/errors';

export type BodyRead = { ok: true; raw: unknown; text: string } | { ok: false; response: Response };

export type TextBodyRead = { ok: true; text: string } | { ok: false; response: Response };

/** Bound raw bytes before decoding or parsing either JSON or URL-encoded forms. */
export async function readTextBody(request: Request, maxBytes: number): Promise<TextBodyRead> {
  let text = '';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try { reader = request.body?.getReader(); } catch {
    return { ok: false, response: errorResponse(400, 'VALIDATION_FAILED', 'Request body could not be read.') };
  }
  if (reader) {
    const decoder = new TextDecoder(); // Request.text() semantics: UTF-8 replacement, BOM removed.
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          // Do not wait for an uncooperative source's cancellation promise.
          void reader.cancel().catch(() => {});
          return { ok: false, response: errorResponse(400, 'VALIDATION_FAILED', `Request body exceeds ${maxBytes} bytes.`) };
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      return { ok: false, response: errorResponse(400, 'VALIDATION_FAILED', 'Request body could not be read.') };
    } finally {
      reader.releaseLock();
    }
  }
  return { ok: true, text };
}

/** Read a JSON body with a hard byte cap. Unknown fields are rejected later by strict zod schemas. */
export async function readJsonBody(request: Request, maxBytes: number, opts?: { allowEmpty?: boolean }): Promise<BodyRead> {
  const body = await readTextBody(request, maxBytes);
  if (!body.ok) return body;
  const { text } = body;
  if (!text.trim()) {
    if (opts?.allowEmpty) return { ok: true, raw: undefined, text: '' };
    return { ok: false, response: errorResponse(400, 'VALIDATION_FAILED', 'Request body is required.') };
  }
  try {
    return { ok: true, raw: JSON.parse(text), text };
  } catch {
    return { ok: false, response: errorResponse(400, 'VALIDATION_FAILED', 'Request body is not valid JSON.') };
  }
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim().slice(0, 64) || 'unknown';
  return request.headers.get('x-real-ip')?.slice(0, 64) ?? 'unknown';
}
