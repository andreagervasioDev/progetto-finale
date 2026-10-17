/** Hash delle password con scrypt (incluso in Node, nessuna dipendenza): formato "salt:hash" in esadecimale. */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(String(password), salt, KEY_LENGTH);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hex] = String(stored ?? "").split(":");
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, "hex");
  const key = await scryptAsync(String(password), salt, expected.length);
  return expected.length === key.length && timingSafeEqual(expected, key);
}
