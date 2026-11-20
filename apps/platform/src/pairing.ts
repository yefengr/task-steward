import { randomBytes, randomUUID } from 'node:crypto';
import { reject } from './errors.js';
import { sha256 } from './store.js';
import type { Store } from './store.js';

export const PAIRING_TTL_MS = 10 * 60_000;
export const MAX_PENDING_PAIRINGS = 256;
const CODE_BYTES = 5;
const CODE_GENERATION_ATTEMPTS = 4;

type PendingPairing = { code: string; name: string; token_hash: string; expires_at: number };
type PairingStatus = 'pending' | 'approved' | 'expired';

export function createPairing(store: Store, input: { name: string; tokenHash: string }, now: () => number) {
  return store.immediate(() => {
    const time = now();
    store.run('DELETE FROM machine_pairings WHERE expires_at<=?', time);
    const { name, tokenHash } = input;
    const pending = store.get<PendingPairing>('SELECT * FROM machine_pairings WHERE token_hash=?', tokenHash);
    if (pending) {
      if (pending.name !== name) reject('conflict', 'Pairing request already uses this token hash');
      return { code: pending.code, expiresAt: pending.expires_at };
    }
    if (store.get('SELECT 1 FROM machines WHERE token_hash=?', tokenHash)) {
      reject('conflict', 'A machine already uses this token hash');
    }
    const { count } = store.get<{ count: number }>('SELECT COUNT(*) AS count FROM machine_pairings')!;
    if (count >= MAX_PENDING_PAIRINGS) reject('rate_limited', 'Too many pending pairing requests');
    const expiresAt = time + PAIRING_TTL_MS;
    for (let attempt = 0; attempt < CODE_GENERATION_ATTEMPTS; attempt++) {
      const code = randomBytes(CODE_BYTES).toString('hex').toUpperCase();
      if (store.run(`INSERT INTO machine_pairings (code, token_hash, name, expires_at)
        VALUES (?,?,?,?) ON CONFLICT(code) DO NOTHING`, code, tokenHash, name, expiresAt).changes) {
        return { code, expiresAt };
      }
    }
    throw new Error('Could not allocate a pairing code');
  });
}

export function pairingStatus(store: Store, token: string, now: number) {
  const tokenHash = sha256(token);
  const { status } = store.get<{ status: PairingStatus }>(`SELECT COALESCE(
    (SELECT CASE WHEN revoked_at IS NULL THEN 'approved' ELSE 'expired' END FROM machines WHERE token_hash=?),
    (SELECT 'pending' FROM machine_pairings WHERE token_hash=? AND expires_at>?), 'expired') AS status`,
  tokenHash, tokenHash, now)!;
  return { status };
}

function requirePendingPairing(store: Store, code: string, now: number) {
  return store.get<PendingPairing>('SELECT * FROM machine_pairings WHERE code=? AND expires_at>?', code, now)
    ?? reject('not_found', 'Pairing request not found');
}

export function inspectPairing(store: Store, code: string, now: number) {
  const pending = requirePendingPairing(store, code, now);
  return { name: pending.name, expiresAt: pending.expires_at };
}

export function approvePairing(store: Store, code: string, now: () => number) {
  return store.immediate(() => {
    const time = now();
    const { name, token_hash } = requirePendingPairing(store, code, time);
    if (store.get('SELECT 1 FROM machines WHERE name=? OR token_hash=?', name, token_hash)) {
      reject('conflict', 'A machine already uses this name or token hash');
    }
    const machineId = randomUUID();
    store.run('INSERT INTO machines (id, name, token_hash, created_at) VALUES (?,?,?,?)', machineId, name, token_hash, time);
    store.run('DELETE FROM machine_pairings WHERE code=?', code);
    return { machineId, name };
  });
}
