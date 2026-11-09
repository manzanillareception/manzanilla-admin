import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** AES-256-GCM delivery payload. Key lives in env (EMAIL_PAYLOAD_KEY, base64 32 bytes), never in the DB. */
export function loadPayloadKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("EMAIL_PAYLOAD_KEY not configured");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("EMAIL_PAYLOAD_KEY must be 32 bytes base64");
  return key;
}

export function encryptPayload(key: Buffer, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(".");
}

export function decryptPayload(key: Buffer, sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("bad payload");
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}
