import { describe, expect, it, vi } from 'vitest';
import { readJsonBody } from '../../src/lib/api/read-body';

function chunks(parts: Uint8Array[], cancel = vi.fn()) {
  let i = 0;
  let reads = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (i < parts.length) controller.enqueue(parts[i++]);
      else controller.close();
    }, cancel,
  }, { highWaterMark: 0 });
  const request = new Request('https://example.test', { method: 'POST', body, duplex: 'half' } as RequestInit);
  return { request, cancel, reads: () => reads };
}
const enc = new TextEncoder();
async function message(result: Awaited<ReturnType<typeof readJsonBody>>) {
  if (result.ok) throw new Error('expected error');
  expect(result.response.status).toBe(400);
  return (await result.response.json()).error.message;
}

describe('stream-bounded JSON body', () => {
  it('accepts exact byte boundary and rejects one byte over', async () => {
    expect((await readJsonBody(new Request('https://example.test', { method: 'POST', body: '{"a":1}' }), 7)).ok).toBe(true);
    expect(await message(await readJsonBody(new Request('https://example.test', { method: 'POST', body: '{"a":1} ' }), 7))).toBe('Request body exceeds 7 bytes.');
  });
  it('counts original bytes, not characters, and handles a multibyte character split across chunks', async () => {
    const raw = '{"a":"😀"}';
    const bytes = enc.encode(raw);
    const { request } = chunks([bytes.slice(0, 7), bytes.slice(7, 8), bytes.slice(8)]);
    const result = await readJsonBody(request, bytes.length);
    expect(result).toEqual({ ok: true, raw: { a: '😀' }, text: raw });
    expect(await message(await readJsonBody(chunks([bytes]).request, bytes.length - 1))).toBe(`Request body exceeds ${bytes.length - 1} bytes.`);
  });
  it('cancels at the first overflowing chunk and never reads subsequent chunks', async () => {
    const c = chunks([enc.encode('1234'), enc.encode('5678'), enc.encode('ignored')]);
    expect(await message(await readJsonBody(c.request, 6))).toBe('Request body exceeds 6 bytes.');
    expect(c.cancel).toHaveBeenCalledOnce();
    expect(c.reads()).toBe(2);
    expect(c.request.body?.locked).toBe(false);
  });
  it('rejects an overflowing first chunk without decoding it', async () => {
    const c = chunks([new Uint8Array(10000), enc.encode('{}')]);
    expect(await message(await readJsonBody(c.request, 8))).toBe('Request body exceeds 8 bytes.');
    expect(c.reads()).toBe(1);
  });
  it('keeps malformed JSON, missing-body and allowEmpty semantics', async () => {
    expect(await message(await readJsonBody(chunks([enc.encode('{oops')]).request, 20))).toBe('Request body is not valid JSON.');
    expect(await message(await readJsonBody(new Request('https://example.test'), 20))).toBe('Request body is required.');
    expect(await readJsonBody(chunks([enc.encode(' \n')]).request, 20, { allowEmpty: true })).toEqual({ ok: true, raw: undefined, text: '' });
  });
  it('preserves Request.text UTF-8 replacement and BOM semantics', async () => {
    const c = chunks([new Uint8Array([239]), new Uint8Array([187,191]), enc.encode('"'), new Uint8Array([255]), enc.encode('"')]);
    expect(await readJsonBody(c.request, 20)).toEqual({ ok: true, raw: '�', text: '"�"' });
  });
  it('counts BOM bytes against the cap', async () => {
    const c = chunks([new Uint8Array([239,187,191]), enc.encode('{}')]);
    expect(await message(await readJsonBody(c.request, 4))).toBe('Request body exceeds 4 bytes.');
  });
  it('maps a stream failure to the existing read error', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new Error('broken')); } });
    const request = new Request('https://example.test', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await message(await readJsonBody(request, 20))).toBe('Request body could not be read.');
    expect(body.locked).toBe(false);
  });
});
