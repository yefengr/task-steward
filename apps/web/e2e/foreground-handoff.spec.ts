import { randomUUID } from 'node:crypto';
import { webTaskDetailResponseSchema } from '@pi-steward/contract';
import { artifact, expect, projectId, test } from './platform-fixture';

test('前台进程未确认退出的 Git 阻塞给出明确操作指引', async ({ page, platform }) => {
  const front = await platform.api.foreground(true);
  await page.route(`**/api/v1/web/tasks/${front.taskId}`, async (route) => {
    const response = await route.fetch();
    const detail = await response.json();
    // 此处只验证展示；真实进程与 Git 操作门禁由 launcher 自动化覆盖。
    detail.task.git = { baseBranch: 'main', baseCommit: 'a'.repeat(40), taskBranch: 'feature/foreground',
      repositoryPath: '/fixture/repo', worktreePath: '/fixture/linked', machineId: front.taskId,
      syncBeforeStart: false, syncResult: 'disabled', phase: 'merge_blocked', operationId: randomUUID(),
      deliveryId: detail.deliveries[0].id, approvedCommit: 'b'.repeat(40), mergedCommit: null,
      message: 'git_foreground_session_active' };
    await route.fulfill({ response, json: detail });
  });
  await page.goto(`${platform.origin}/tasks/${front.taskId}`);
  await page.getByLabel('访问密码').fill(platform.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '请退出原 Pi 后重试' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试合并', exact: true })).toBeVisible();
});

test('前台返修排队仍需原进程退出核对，失败后提供手动接续入口', async ({ page, platform }) => {
  const { origin, password, api } = platform;
  const front = await api.foreground(true);
  await api.foregroundControl();
  await page.goto(`${origin}/tasks/${front.taskId}`);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '返修', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('返修反馈').fill('请按原对话继续核对');
  await dialog.getByRole('button', { name: '返修', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await api.claim()).toBeNull();
  const heartbeat = await api.foregroundControl();
  const op = heartbeat.sessionOperations!.find((op) => op.mode === 'background')!;
  expect(op).toMatchObject({ attemptId: front.attemptId, step: 'stop' });
  await api.sessionReport(op.id, { step: 'stop', result: 'failed', failure: 'session_source_alive' });
  await page.reload();
  await expect(page.getByText(/已请求返修。普通 Pi 即使已交付/)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '前台原 Pi 进程仍在运行' })).toBeVisible();
  await expect(page.getByRole('button', { name: '后台继续', exact: true })).toBeVisible();
  const retry = { requestId: randomUUID(), attemptId: front.attemptId, mode: 'background' };
  const response = await page.request.post(`${origin}/api/v1/web/tasks/${front.taskId}/session-operation`, { headers: { Origin: origin }, data: retry });
  expect(response.status()).toBe(200);
  await api.sessionReport(retry.requestId, { step: 'stop', result: 'stopped' });
  const detail = webTaskDetailResponseSchema.parse(await (await page.request.get(`${origin}/api/v1/web/tasks/${front.taskId}`)).json());
  expect(detail.attempts.at(-1)?.kind).toBe('rework');
});

for (const mobile of [false, true]) test(`前台来源、后台继续确认与失败、接续后保留来源（${mobile ? '手机' : '桌面'}）`, async ({ page, platform }) => {
  const { origin, password, api } = platform;
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  const front = await api.foreground();
  await api.foregroundControl();
  await page.goto(`${origin}/projects/${projectId}`);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('link', { name: /前台纳管与后台接续/ }).click();
  await expect(page.getByText('用户前台发起 · 前台执行', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新安排', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '恢复原会话', exact: true })).toBeHidden();
  async function requestBackground() {
    await page.getByRole('button', { name: '后台继续', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('不会结束仍在运行的前台进程');
    const response = page.waitForResponse((response) => response.url().endsWith('/session-operation') && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '后台继续', exact: true }).click();
    const sent = await response;
    expect(sent.status()).toBe(200);
    const body = sent.request().postDataJSON() as { requestId: string; mode: string };
    expect(body.mode).toBe('background');
    await expect(dialog).toBeHidden();
    return body.requestId;
  }
  const failed = await requestBackground();
  await api.sessionReport(failed, { step: 'stop', result: 'failed', failure: 'session_source_alive' });
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: '前台原 Pi 进程仍在运行' })).toBeVisible();
  await expect(page.getByText('用户前台发起 · 前台执行', { exact: true })).toBeVisible();
  const retry = await requestBackground();
  expect(retry).not.toBe(failed);
  await api.sessionReport(retry, { step: 'stop', result: 'stopped' });
  const detail = webTaskDetailResponseSchema.parse(await (await page.request.get(`${origin}/api/v1/web/tasks/${front.taskId}`)).json());
  const replacement = detail.attempts.at(-1)!;
  expect(replacement.id).not.toBe(front.attemptId);
  await api.started(replacement.id);
  await api.session(replacement.id, front.sessionId);
  await page.reload();
  await expect(page.getByText('用户前台发起 · 后台接续中', { exact: true })).toBeVisible();
  await expect(page.getByText(/原对话已在后台接续/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: artifact(`foreground-${mobile ? 'mobile' : 'desktop'}.png`), fullPage: true });
  await page.goto(`${origin}/projects/${projectId}`);
  await expect(page.getByText('用户前台发起 · 后台接续中', { exact: true })).toBeVisible();
});
