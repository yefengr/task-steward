import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { originConfig, revokeMachine } from '../src/auth.js';
import { errorCode, project, request, useFixture } from './fixture.js';

const setup = useFixture();

it('精确 Origin、JSON、浏览器会话、退出与过期', async () => {
  const x = await setup({ secure: true, login: false });
  expect(() => originConfig('http://example.com', true)).toThrow();
  expect(() => originConfig('http://127.0.0.1:3000', false)).toThrow();
  expect(() => originConfig('https://steward.example/', false)).toThrow();
  await errorCode(await x.login(undefined, { Origin: 'https://steward.example.evil.test' }), 403, 'forbidden');
  await errorCode(await x.login(undefined, { 'Content-Type': 'text/plain' }), 400, 'invalid_request');
  const result = await x.login();
  expect(result.status).toBe(200);
  const header = result.headers.get('set-cookie') ?? '';
  expect(header.split('; ').slice(1)).toEqual(expect.arrayContaining(['Max-Age=2592000', 'Path=/api/v1/web', 'HttpOnly', 'Secure', 'SameSite=Strict']));
  const Cookie = header.split(';', 1)[0]!;
  expect(await (await x.web('/auth/me')).json()).toEqual({ authenticated: false });
  expect(await (await x.send('/web/auth/me', undefined, { headers: { Cookie } })).json()).toEqual({ authenticated: true });
  await errorCode(await x.send('/web/auth/logout', {}, { headers: { Cookie } }), 403, 'forbidden');
  const loggedOut = await x.send('/web/auth/logout', {}, { web: true, headers: { Cookie } });
  expect(loggedOut.status).toBe(200);
  expect(loggedOut.headers.get('set-cookie')?.includes('Max-Age=0')).toBe(true);
  await errorCode(await x.send('/web/projects', undefined, { headers: { Cookie } }), 401, 'unauthorized');
  const session = (await x.login()).headers.get('set-cookie')!.split(';', 1)[0]!;
  x.advance(30 * 24 * 60 * 60 * 1000);
  expect(await (await x.send('/web/auth/me', undefined, { headers: { Cookie: session } })).json()).toEqual({ authenticated: false });
});

it('忽略未受信来源地址并限制失败次数，到期恢复', async () => {
  const x = await setup({ login: false });
  const synthetic = randomBytes(20).toString('hex');
  for (let i = 1; i <= 5; i++) await errorCode(await x.login(synthetic, { 'X-Steward-Client-IP': `192.0.2.${i}` }), 401, 'unauthorized');
  await errorCode(await x.login(), 429, 'rate_limited');
  x.advance(60_000);
  const response = await x.login();
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')?.split('; ').includes('Secure')).toBe(false);
});

it('显式信任代理覆盖的头时按来源限流', async () => {
  const x = await setup({ login: false, trustProxy: true });
  const synthetic = randomBytes(20).toString('hex');
  const headers = { 'X-Steward-Client-IP': '192.0.2.1' };
  for (let i = 0; i < 5; i++) await errorCode(await x.login(synthetic, headers), 401, 'unauthorized');
  await errorCode(await x.login(undefined, headers), 429, 'rate_limited');
  expect((await x.login(undefined, { 'X-Steward-Client-IP': '192.0.2.2' })).status).toBe(200);
});

it('浏览器 Cookie、机器令牌与 Agent 尝试归属检查，撤销优先于重放', async () => {
  const x = await setup();
  await errorCode(await x.send('/launcher/claim', request(), { web: true }), 401, 'unauthorized');
  await errorCode(await x.send('/web/projects', undefined, { machine: x.token }), 401, 'unauthorized');
  await errorCode(await x.send('/agent/context', undefined, { machine: x.token }), 401, 'unauthorized');
  await x.heartbeat(1, [project]);
  const task = await x.create();
  await x.action(task.id, 'schedule');
  const claimRequest = request();
  const payload = await (await x.claim(claimRequest)).json() as { attempt: { id: string } };
  const attemptId = payload.attempt.id;
  await errorCode(await x.send('/agent/context', undefined, { web: true, attempt: attemptId }), 401, 'unauthorized');
  await errorCode(await x.send('/agent/context', undefined, { machine: x.otherToken, attempt: attemptId }), 403, 'forbidden');
  await errorCode(await x.launcher(`/attempts/${attemptId}/exited`, request({ endedAt: x.now(), exitCode: null }), x.otherToken), 403, 'forbidden');
  expect((await x.agent(attemptId, '/context')).status).toBe(200);
  expect(revokeMachine(x.store, 'Mac', x.now())).toBe(true);
  await errorCode(await x.claim(claimRequest), 401, 'unauthorized');
  await errorCode(await x.agent(attemptId, '/context'), 401, 'unauthorized');
});
