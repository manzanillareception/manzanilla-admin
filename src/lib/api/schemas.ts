import { z } from 'zod';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/);
const build = z.string().regex(/^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$/);
const timestamp = z.iso.datetime({ offset: true });
const access = z.enum(['pending', 'approved', 'blocked']);

export const enrollSchema = z.strictObject({
  setupToken: z.string().min(1).max(4096).regex(/^\S+$/, 'No whitespace allowed').optional(),
  label: z.string().min(1).max(80),
  build,
  bootId: z.uuid(),
});

export const heartbeatSchema = z.strictObject({
  bootId: z.uuid(),
  sequence: z.number().int().min(0).max(2_147_483_647),
  build,
  mode: z.enum(['idle', 'translation', 'reception']),
  microphone: z.enum(['granted', 'denied', 'unknown']),
  occurredAt: timestamp,
});

export const policyAckSchema = z.strictObject({
  revision: z.number().int().min(1).max(2_147_483_647),
  bootId: z.uuid(),
  sequence: z.number().int().min(0).max(2_147_483_647),
});

export const sessionAdmissionSchema = z.strictObject({
  sessionId: identifier,
  attemptId: identifier,
  feature: z.enum(['translation', 'reception']),
});

export const adminPolicySchema = z.strictObject({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  desiredAccess: access,
  reason: z.string().min(1).max(500),
});

export const repairRequestSchema = z.strictObject({
  target: z.enum(['android_handoff', 'new_admin_repo', 'manual_runbook']),
});

export const setupTokenMintSchema = z.strictObject({
  hotelId: z.uuid(),
  expiresInHours: z.number().int().min(1).max(72).optional(),
});

export { access as accessSchema, build as buildSchema, identifier as identifierSchema, timestamp as timestampSchema };

export const triageSchema = z.strictObject({
  note: z.string().max(500).optional(),
});
