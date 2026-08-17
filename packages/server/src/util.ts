import { v7 as uuidv7 } from 'uuid';
import crypto from 'node:crypto';

export function newId(): string {
  return uuidv7();
}

export function nowIso(): string {
  return new Date().toISOString();
}

// --- password hashing (Node built-in scrypt; no external services) ---------

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N })
    .toString('hex');
  return `scrypt:${SCRYPT_N}:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, nStr, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !nStr || !salt || !hash) return false;
  const candidate = crypto
    .scryptSync(password, salt, SCRYPT_KEYLEN, { N: Number(nStr) })
    .toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(hash, 'hex'));
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Error with an HTTP status + stable machine code, thrown by services. */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function badRequest(code: string, message: string): never {
  throw new AppError(400, code, message);
}
export function forbidden(code: string, message: string): never {
  throw new AppError(403, code, message);
}
export function notFound(code: string, message: string): never {
  throw new AppError(404, code, message);
}
export function conflict(code: string, message: string): never {
  throw new AppError(409, code, message);
}
