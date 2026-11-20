import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import * as c from '@pi-steward/contract';
import { createApp } from '../src/app.js';
import { hashPassword, newMachineToken, revokeMachine } from '../src/auth.js';
import { MAX_PENDING_PAIRINGS, PAIRING_TTL_MS } from '../src/pairing.js';
import { sha256 } from '../src/store.js';
import { errorCode, origin, useFixture } from './fixture.js';

const setup = useFixture();

type Fixture = Awaited<ReturnType<typeof setup>>;
async function create(x: Fixture, name: string, machineToken = newMachineToken()) {
  const response = await x.send('/pairing/create', { name, tokenHash: sha256(machineToken) });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return { ...c.createPairingResponseSchema.parse(await response.json()), machineToken };
}
async function status(x: Fixture, machineToken: string) {
  const response = await x.send('/pairing/status', { machineToken });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return c.pairingStatusResponseSchema.parse(await response.json()).status;
}

it('申请重放、检查、一次审批、重复查询、正常心跳及撤销', async () => {
  const x = await setup();
  const pending = await create(x, '  MacBook  ');
  const { code, machineToken, expiresAt } = pending;
  expect(expiresAt).toBe(x.now() + 10 * 60_000);
  x.advance(100);
  expect(await create(x, 'MacBook', machineToken)).toEqual(pending);
  await errorCode(await x.send('/pairing/create', { name: 'iMac', tokenHash: sha256(machineToken) }), 409, 'conflict');
  expect(await status(x, machineToken)).toBe('pending');
  expect(await status(x, newMachineToken())).toBe('expired');
  expect(x.store.get('SELECT token_hash FROM machine_pairings WHERE code=?', code)).toEqual({ token_hash: sha256(machineToken) });
  await errorCode(await x.heartbeat(1, [], [], machineToken), 401, 'unauthorized');

  const inspected = await x.web('/pairing/inspect', { code });
  expect(inspected.status).toBe(200);
  expect(inspected.headers.get('Cache-Control')).toBe('no-store');
  expect(await inspected.json()).toEqual({ name: 'MacBook', expiresAt });
  const approvals = await Promise.all([x.web('/pairing/approve', { code }), x.web('/pairing/approve', { code })]);
  const [accepted, repeated] = approvals.sort((a, b) => a.status - b.status);
  expect(accepted!.status).toBe(200);
  const { machineId, name } = c.webApprovePairingResponseSchema.parse(await accepted!.json());
  expect(name).toBe('MacBook');
  expect(x.store.get('SELECT id, token_hash, revoked_at FROM machines WHERE name=?', name)).toEqual({
    id: machineId, token_hash: sha256(machineToken), revoked_at: null,
  });
  await errorCode(repeated!, 404, 'not_found');
  await errorCode(await x.web('/pairing/inspect', { code }), 404, 'not_found');
  expect(await status(x, machineToken)).toBe('approved');
  expect(await status(x, machineToken)).toBe('approved');
  expect((await x.heartbeat(1, [], [], machineToken)).status).toBe(200);
  expect(revokeMachine(x.store, name, x.now())).toBe(true);
  expect(await status(x, machineToken)).toBe('expired');
  await errorCode(await x.send('/pairing/create', { name, tokenHash: sha256(machineToken) }), 409, 'conflict');
});

it('同名审批返回冲突且保留现有机器，包含已撤销记录', async () => {
  const x = await setup();
  const { code, machineToken } = await create(x, 'Mac');
  await errorCode(await x.web('/pairing/approve', { code }), 409, 'conflict');
  expect(revokeMachine(x.store, 'Mac', x.now())).toBe(true);
  await errorCode(await x.web('/pairing/approve', { code }), 409, 'conflict');
  expect(x.store.all('SELECT id, token_hash, revoked_at FROM machines WHERE name=?', 'Mac')).toEqual([
    { id: x.machineId, token_hash: sha256(x.token), revoked_at: x.now() },
  ]);
  expect(await status(x, machineToken)).toBe('pending');
});

it('到期时查询、检查及审批均失效，新申请清理过期记录', async () => {
  const x = await setup();
  const { code, machineToken } = await create(x, 'Expired');
  x.advance(PAIRING_TTL_MS - 1);
  expect(await status(x, machineToken)).toBe('pending');
  x.advance(1);
  expect(await status(x, machineToken)).toBe('expired');
  await errorCode(await x.web('/pairing/inspect', { code }), 404, 'not_found');
  await errorCode(await x.web('/pairing/approve', { code }), 404, 'not_found');
  expect((await create(x, 'Fresh', machineToken)).expiresAt).toBe(x.now() + PAIRING_TTL_MS);
  expect(x.store.all('SELECT name FROM machine_pairings')).toEqual([{ name: 'Fresh' }]);
});

it('Web 接口要求同源和登录，配对参数使用严格 JSON 请求体', async () => {
  const x = await setup({ login: false });
  const { code, machineToken } = await create(x, 'Test Mac');
  for (const action of ['inspect', 'approve']) {
    await errorCode(await x.web(`/pairing/${action}`, { code }), 401, 'unauthorized');
  }
  const session = (await x.login()).headers.get('set-cookie')!.split(';', 1)[0]!;
  for (const action of ['inspect', 'approve']) {
    const path = `/web/pairing/${action}`;
    await errorCode(await x.send(path, { code }, { headers: { Cookie: session } }), 403, 'forbidden');
    await errorCode(await x.send(path, { code }, { headers: { Cookie: session, Origin: 'https://other.example' } }), 403, 'forbidden');
    await errorCode(await x.send(`${path}?code=${code}`, {}, { headers: { Cookie: session, Origin: origin } }), 400, 'invalid_request');
    await errorCode(await x.send(path, { code, machineToken }, { headers: { Cookie: session, Origin: origin } }), 400, 'invalid_request');
  }
  const input = { name: 'MacBook', tokenHash: sha256(machineToken) };
  await errorCode(await x.send('/pairing/create', { ...input, machineToken }), 400, 'invalid_request');
  await errorCode(await x.send('/pairing/create', input, { headers: { 'Content-Type': 'text/plain' } }), 400, 'invalid_request');
  const large = await x.send('/pairing/create', { ...input, name: 'a'.repeat(2048) });
  expect(large.headers.get('Cache-Control')).toBe('no-store');
  expect(await large.clone().json()).toMatchObject({ error: { message: 'Request body too large' } });
  await errorCode(large, 400, 'invalid_request');
  await errorCode(await x.send('/pairing/status', { machineToken: input.tokenHash }), 400, 'invalid_request');
  await errorCode(await x.send('/pairing/status', { machineToken, name: input.name }), 400, 'invalid_request');
  await errorCode(await x.send(`/web/pairing/approve?code=${code}`, undefined, { headers: { Cookie: session } }), 404, 'not_found');
});

it('按可信来源和全局限制创建次数，状态查询和审批不受创建限流影响', async () => {
  const x = await setup();
  const { code, machineToken } = await create(x, 'Pending');
  for (let i = 1; i < 10; i++) {
    const headers = { 'X-Steward-Client-IP': `192.0.2.${i}` };
    expect((await x.send('/pairing/create', { name: 'Pending', tokenHash: sha256(machineToken) }, { headers })).status).toBe(200);
  }
  const limited = await x.send('/pairing/create', { name: 'Pending', tokenHash: sha256(machineToken) },
    { headers: { 'X-Steward-Client-IP': '192.0.2.254' } });
  expect(limited.headers.get('Cache-Control')).toBe('no-store');
  await errorCode(limited, 429, 'rate_limited');
  expect(await status(x, machineToken)).toBe('pending');
  expect((await x.web('/pairing/approve', { code })).status).toBe(200);
  x.advance(60_000);
  await create(x, 'Recovered');

  const trusted = await setup({ login: false, trustProxy: true });
  const from = (ip: string) => trusted.send('/pairing/create', { name: 'Distributed', tokenHash: sha256(newMachineToken()) },
    { headers: { 'X-Steward-Client-IP': ip } });
  for (let i = 0; i < 10; i++) expect((await from('2001:DB8::1')).status).toBe(200);
  await errorCode(await from('2001:0db8:0:0:0:0:0:1'), 429, 'rate_limited');
  for (let i = 1; i <= 50; i++) expect((await from(`192.0.2.${i}`)).status).toBe(200);
  await errorCode(await from('192.0.2.51'), 429, 'rate_limited');
  trusted.advance(60_000);
  expect((await from('192.0.2.51')).status).toBe(200);
});

it('持久化待配对容量达到上限时仍可重放，过期后释放容量', async () => {
  const x = await setup({ login: false });
  const request = await create(x, 'Pending');
  x.store.immediate(() => {
    for (let i = 0; i < MAX_PENDING_PAIRINGS - 1; i++) {
      x.store.run('INSERT INTO machine_pairings (code, token_hash, name, expires_at) VALUES (?,?,?,?)',
        i.toString(), sha256(`fixture-${i}`), 'Fixture', request.expiresAt);
    }
  });
  const input = { name: 'Waiting', tokenHash: sha256(newMachineToken()) };
  await errorCode(await x.send('/pairing/create', input), 429, 'rate_limited');
  expect(await create(x, 'Pending', request.machineToken)).toEqual(request);
  expect(x.store.get('SELECT COUNT(*) AS count FROM machine_pairings')).toEqual({ count: MAX_PENDING_PAIRINGS });
  x.advance(PAIRING_TTL_MS);
  expect((await x.send('/pairing/create', input)).status).toBe(200);
  expect(x.store.get('SELECT COUNT(*) AS count FROM machine_pairings')).toEqual({ count: 1 });
});

it('直接请求公开 /pair 路径时返回 SPA 入口', async () => {
  const x = await setup({ login: false });
  const directory = await mkdtemp(join(tmpdir(), 'pi-steward-pair-web-'));
  const page = '<!DOCTYPE html><title>Steward SPA</title>';
  try {
    await writeFile(join(directory, 'index.html'), page);
    const app = createApp({ store: x.store, accessPasswordHash: await hashPassword(newMachineToken()), publicOrigin: origin,
      allowLocalHttp: true, webDir: directory });
    const response = await app.request('/pair');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toBe(page);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
