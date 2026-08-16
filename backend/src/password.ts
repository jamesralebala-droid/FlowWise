import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derivedKey) =>
      err ? reject(err) : resolve(derivedKey),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const N = 16384, r = 8, p = 1;
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEYLEN, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nS, rS, pS, saltB64, hashB64] = parts;
  const derived = await scryptAsync(password, Buffer.from(saltB64!, "base64"), KEYLEN, {
    N: Number(nS), r: Number(rS), p: Number(pS),
  });
  return timingSafeEqual(derived, Buffer.from(hashB64!, "base64"));
}
