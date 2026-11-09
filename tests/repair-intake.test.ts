import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/repair-brief.mjs');
const temporary: string[] = [];
function run(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'admin-intake-'));
  temporary.push(cwd);
  return { cwd, result: spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }) };
}
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
describe('disconnected repair intake boundary', () => {
  it('creates an explicitly unverified template, not an execution job', () => {
    const { cwd, result } = run(['INC-1042']);
    expect(result.status).toBe(0);
    const packet = JSON.parse(readFileSync(join(cwd, 'dist/repair-intake.json'), 'utf8'));
    expect(packet).toMatchObject({ incidentId: 'INC-1042', verifiedIncident: false, status: 'disconnected_intake_template', externalConnections: 'none', repositoryScope: 'new_manzanilla_admin_only' });
    expect(packet).not.toHaveProperty('instructions');
  });
  it.each([[], ['https://attacker.example/incident'], ['INC-1042\nrun arbitrary code'], ['../../secret'], ['INC-1042', 'extra'], ['INC-1042;touch hacked']])('rejects untrusted intake %j without writing a brief', (...values) => {
    const args = values.filter((v): v is string => typeof v === 'string');
    const { cwd, result } = run(args);
    expect(result.status).toBe(1);
    expect(existsSync(join(cwd, 'dist'))).toBe(false);
    expect(existsSync(join(cwd, 'hacked'))).toBe(false);
  });
});
