import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// This script has no network access, secret reads, external command execution or
// dynamic imports. An incident ID is a reference, never executable instructions.
const args = process.argv.slice(2);
if (args.length !== 1 || !/^INC-[1-9][0-9]{0,8}$/.test(args[0])) {
  console.error('Usage: node scripts/repair-brief.mjs INC-1042');
  process.exitCode = 1;
} else {
  const packet = {
    schemaVersion: 1,
    incidentId: args[0],
    status: 'disconnected_intake_template',
    verifiedIncident: false,
    createdAt: new Date().toISOString(),
    repositoryScope: 'new_manzanilla_admin_only',
    externalConnections: 'none',
    includesGuestContent: false,
    nextSteps: [
      'A trusted operator must resolve and verify this incident from the future database.',
      'Build an allowlisted metadata brief and reproduce before proposing code changes.',
      'Android incidents require a separate handoff; no old-repository writes are authorized.',
      'Use an isolated branch, meaningful tests and a draft PR; no auto-merge or release.',
    ],
  };
  const destination = resolve('dist/repair-intake.json');
  await mkdir(resolve('dist'), { recursive: true });
  await writeFile(destination, `${JSON.stringify(packet, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log('Prepared dist/repair-intake.json — disconnected template, no external action.');
}
