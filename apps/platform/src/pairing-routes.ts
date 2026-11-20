import { SocketAddress } from 'node:net';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import * as c from '@pi-steward/contract';
import { errorBody, jsonInput } from './app.js';
import type { AppOptions } from './app.js';
import { loginSource } from './auth.js';
import { reject } from './errors.js';
import { approvePairing, createPairing, inspectPairing, pairingStatus } from './pairing.js';
import type { Store } from './store.js';

const CREATE_WINDOW_MS = 60_000;
const CREATE_PER_SOURCE = 10;
const CREATE_GLOBAL = 60;
const MAX_PAIRING_BODY_BYTES = 2 * 1024;

class PairingCreateLimiter {
  private expiresAt = 0;
  private total = 0;
  private readonly sources = new Map<string, number>();

  reserve(source: string, now: number) {
    if (now >= this.expiresAt) {
      this.expiresAt = now + CREATE_WINDOW_MS;
      this.total = 0;
      this.sources.clear();
    }
    const count = this.sources.get(source) ?? 0;
    if (count >= CREATE_PER_SOURCE || this.total >= CREATE_GLOBAL) {
      reject('rate_limited', 'Too many pairing requests');
    }
    this.sources.set(source, count + 1);
    this.total++;
  }
}

function canonicalSource(source: string) {
  if (!source.includes(':')) return source;
  const address = source.split('%', 1)[0];
  const normalized = SocketAddress.parse(`[${address}]`)?.address ?? source;
  return normalized.replace(/^::ffff:/, '');
}

export function mountPublicPairing(options: AppOptions, now: () => number) {
  const api = new Hono();
  const limiter = new PairingCreateLimiter();
  const limitBody = bodyLimit({ maxSize: MAX_PAIRING_BODY_BYTES,
    onError: (context) => context.json(errorBody('invalid_request', 'Request body too large'), 400) });
  api.post('/create', async (context, next) => {
    const source = loginSource(context.req.raw, options.trustProxyClientIp ?? false, options.peerIp?.(context));
    limiter.reserve(canonicalSource(source), now());
    await next();
  }, limitBody, async (context) => {
    const input = await jsonInput(context, c.createPairingRequestSchema);
    return context.json(c.createPairingResponseSchema.parse(createPairing(options.store, input, now)));
  });
  api.post('/status', limitBody, async (context) => {
    const { machineToken } = await jsonInput(context, c.pairingStatusRequestSchema);
    return context.json(c.pairingStatusResponseSchema.parse(pairingStatus(options.store, machineToken, now())));
  });
  return api;
}

export function mountWebPairing(store: Store, now: () => number) {
  const web = new Hono();
  web.post('/inspect', async (context) => {
    const { code } = await jsonInput(context, c.webPairingRequestSchema);
    return context.json(c.webPairingResponseSchema.parse(inspectPairing(store, code, now())));
  });
  web.post('/approve', async (context) => {
    const { code } = await jsonInput(context, c.webPairingRequestSchema);
    return context.json(c.webApprovePairingResponseSchema.parse(approvePairing(store, code, now)));
  });
  return web;
}
