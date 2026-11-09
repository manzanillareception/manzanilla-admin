import { describe, expect, it } from 'vitest';
import { setupRequired } from '../src/lib/setup-required';
describe('unconfigured control plane', () => {
  it('denies production requests without reflecting input or pretending to persist', async () => {
    const response = setupRequired();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).error.code).toBe('SETUP_REQUIRED');
  });
});
