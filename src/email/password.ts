import { randomInt } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

/** Strong random initial password. Unambiguous characters so it survives being typed on a tablet. */
export function generateInitialPassword(length = 16): string {
  if (length < 14) throw new Error("password too short");
  for (;;) {
    let out = "";
    for (let i = 0; i < length; i++) out += ALPHABET[randomInt(ALPHABET.length)];
    if (/[a-z]/.test(out) && /[A-Z]/.test(out) && /[2-9]/.test(out)) return out;
  }
}
