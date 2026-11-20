import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { machineTokenSchema } from '@pi-steward/contract';
import { reject } from './errors.js';
import { sha256 } from './store.js';
import type { Store } from './store.js';

const derive = promisify(scrypt);
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_COOKIE = 'steward_session';
const passwordFormat = /^scrypt\$([0-9a-f]{32})\$([0-9a-f]{128})$/;

export async function hashPassword(password: string) {
  if (!password || password.length > 1024) throw new Error('Password must contain 1–1024 characters');
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function passwordVerifier(hash: string) {
  const match = passwordFormat.exec(hash);
  if (!match?.[1] || !match[2]) throw new Error('Invalid access password hash');
  const salt = Buffer.from(match[1], 'hex');
  const expected = Buffer.from(match[2], 'hex');
  return async (password: string) => timingSafeEqual(expected, await derive(password, salt, expected.length) as Buffer);
}

const LOGIN_WINDOW_MS = 60_000;
const FAILED_LOGIN_LIMIT = 5;
const SOURCE_LIMIT = 4096;
export class LoginLimiter {
  private readonly windows = new Map<string, { expires: number; attempts: number }>();
  private sweepAt = 0;
  reserve(source: string, now: number) {
    if (now >= this.sweepAt) {
      for (const [key, value] of this.windows) if (value.expires <= now) this.windows.delete(key);
      this.sweepAt = now + LOGIN_WINDOW_MS;
    }
    const key = this.windows.has(source) || this.windows.size < SOURCE_LIMIT ? source : 'overflow';
    let window = this.windows.get(key);
    if (!window || window.expires <= now) {
      window = { expires: now + LOGIN_WINDOW_MS, attempts: 0 };
      this.windows.set(key, window);
    }
    if (window.attempts >= FAILED_LOGIN_LIMIT) reject('rate_limited', 'Too many login attempts');
    window.attempts++;
    const current = window;
    return () => { current.attempts--; };
  }
}

export function originConfig(publicOrigin: string, allowLocalHttp: boolean) {
  const origin = new URL(publicOrigin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== publicOrigin || !(origin.protocol === 'https:' || (allowLocalHttp && loopback && origin.protocol === 'http:'))) {
    throw new Error('STEWARD_PUBLIC_ORIGIN must be an exact HTTPS origin or an explicitly enabled loopback HTTP origin');
  }
  return { origin: origin.origin, secure: origin.protocol === 'https:' };
}
export function loginSource(request: Request, trustProxy: boolean, peerIp?: string) {
  const forwarded = trustProxy ? request.headers.get('x-steward-client-ip') : null;
  if (forwarded && isIP(forwarded)) return forwarded;
  return peerIp && isIP(peerIp) ? peerIp : 'shared';
}
export function createWebSession(store: Store, now: number) {
  const token = randomBytes(32).toString('base64url');
  store.immediate(() => {
    store.run('DELETE FROM web_sessions WHERE expires_at<=?', now);
    store.run('INSERT INTO web_sessions VALUES (?,?,?)', sha256(token), now, now + SESSION_LIFETIME_MS);
  });
  return { token, maxAge: SESSION_LIFETIME_MS / 1000 };
}
export function webSessionValid(store: Store, token: string | undefined, now: number) {
  return !!token && /^[A-Za-z0-9_-]{43}$/.test(token) &&
    !!store.get('SELECT 1 FROM web_sessions WHERE id_hash=? AND expires_at>?', sha256(token), now);
}
export function deleteWebSession(store: Store, token: string | undefined) {
  if (token) store.run('DELETE FROM web_sessions WHERE id_hash=?', sha256(token));
}
export const newMachineToken = () => `stm_${randomBytes(32).toString('base64url')}`;
export function addMachine(store: Store, name: string, token: string, now: number) {
  if (!name.trim() || name.length > 128 || /[\p{Cc}]/u.test(name) || !machineTokenSchema.safeParse(token).success) {
    throw new Error('Invalid machine name or token format');
  }
  const id = randomUUID();
  store.run('INSERT INTO machines (id, name, token_hash, created_at) VALUES (?,?,?,?)', id, name, sha256(token), now);
  return id;
}
export function revokeMachine(store: Store, name: string, now: number) {
  return store.run('UPDATE machines SET revoked_at=COALESCE(revoked_at,?) WHERE name=?', now, name).changes !== 0;
}
export function requireMachineAuth(store: Store, header: string | undefined) {
  const match = /^Bearer (\S+)$/i.exec(header ?? '');
  const token = machineTokenSchema.safeParse(match?.[1]);
  if (!token.success) reject('unauthorized', 'Valid machine credentials required');
  const machine = store.get<{ id: string }>('SELECT id FROM machines WHERE token_hash=? AND revoked_at IS NULL', sha256(token.data));
  return machine?.id ?? reject('unauthorized', 'Valid machine credentials required');
}
