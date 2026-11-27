import type { Page } from '@playwright/test';
import { webTaskDetailResponseSchema, webTaskMutationResponseSchema } from '@pi-steward/contract';
import { artifact, expect, projectId, test } from './platform-fixture';
import type { PlatformFixture } from './platform-fixture';

type SessionDirective = NonNullable<Awaited<ReturnType<PlatformFixture['api']['foregroundControl']>>['sessionOperations']>[number];

async function login(page: Page, origin: string, password: string, path = `/projects/${projectId}`) {
  await page.goto(origin + path);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
}

async function createBackgroundTask(page: Page, platform: PlatformFixture, title: string) {
  const response = await page.request.post(`${platform.origin}/api/v1/web/tasks`, {
    headers: { Origin: platform.origin },
    data: { projectId, title, goal: '生命周期验收', acceptance: '', notes: '', agent: 'pi', machineId: platform.machineId, type: 'implementation' },
  });
  expect(response.status()).toBe(201);
  return webTaskMutationResponseSchema.parse(await response.json()).task;
}

async function runToDelivery(page: Page, platform: PlatformFixture, title: string) {
  const task = await createBackgroundTask(page, platform, title);
  const scheduled = await page.request.post(`${platform.origin}/api/v1/web/tasks/${task.id}/schedule`, {
    headers: { Origin: platform.origin }, data: {},
  });
  expect(scheduled.status()).toBe(200);
  const attempt = await platform.api.claim();
  if (!attempt) throw new Error('The test launcher did not receive the task');
  expect(attempt.taskId).toBe(task.id);
  await platform.api.session(attempt.id, attempt.sessionId);
  await platform.api.started(attempt.id);
  const delivery = await platform.api.deliver(attempt.id, `${title}交付`);
  return { task, attempt, delivery };
}

async function submitPause(page: Page) {
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('当前回复或工具操作可能中止');
  await expect(dialog).toContainText('已经写入的文件不会回滚');
  await expect(dialog).toContainText('外部请求也可能已经生效');
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/session-operation') && candidate.request().method() === 'POST');
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const sent = await response;
  expect(sent.status()).toBe(200);
  await expect(dialog).toBeHidden();
  const body = sent.request().postDataJSON() as { attemptId: string; mode: string; requestId: string };
  expect(body.mode).toBe('pause');
  expect(body.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  return body;
}

async function pauseDirective(platform: PlatformFixture, mode: 'pause' | 'continue' | 'finalize') {
  const heartbeat = await platform.api.foregroundControl();
  const directive = heartbeat.sessionOperations?.find((operation) => operation.mode === mode) as SessionDirective | undefined;
  if (!directive) throw new Error(`No ${mode} directive was issued`);
  return directive;
}

async function detail(page: Page, platform: PlatformFixture, taskId: string) {
  return webTaskDetailResponseSchema.parse(await (await page.request.get(
    `${platform.origin}/api/v1/web/tasks/${taskId}`)).json());
}

test('桌面暂停警示、进程确认后显示已暂停并继续恢复原对话', async ({ page, platform }) => {
  const { origin, password, api } = platform;
  await page.setViewportSize({ width: 1280, height: 900 });
  const front = await api.foregroundActive();
  await api.foregroundControl();
  await login(page, origin, password, `/tasks/${front.taskId}`);

  const sent = await submitPause(page);
  expect(sent.attemptId).toBe(front.attemptId);
  await expect(page.getByRole('status').filter({ hasText: '正在请求原 Pi 暂停' })).toBeVisible();

  const pause = await pauseDirective(platform, 'pause');
  await api.sessionReport(pause.id, { step: 'stop', result: 'stopped' });
  await page.reload();
  await expect(page.locator('.detail-head')).toContainText('已暂停');
  await expect(page.getByText(/本轮已暂停，原对话和工作现场保留/)).toBeVisible();
  await expect(page.getByRole('button', { name: '重新安排', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: '恢复原会话', exact: true })).toBeHidden();

  await page.getByRole('button', { name: '继续', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('原 Mac');
  await expect(dialog).toContainText('先核对任务、实际进展和中断操作的结果');
  const response = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/session-operation') && candidate.request().method() === 'POST');
  await dialog.getByRole('button', { name: '继续', exact: true }).click();
  const continued = await response;
  expect(continued.status()).toBe(200);
  const body = continued.request().postDataJSON() as { attemptId: string; mode: string };
  expect(body).toMatchObject({ attemptId: front.attemptId, mode: 'continue' });
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: '正在核对原现场并恢复原对话' })).toBeVisible();

  const continuation = await pauseDirective(platform, 'continue');
  await api.sessionReport(continuation.id, { step: 'stop', result: 'stopped' });
  const restored = await detail(page, platform, front.taskId);
  const replacement = restored.attempts.at(-1);
  if (!replacement) throw new Error('No continuation attempt');
  expect(replacement.id).not.toBe(front.attemptId);
  await api.started(replacement.id);
  await api.session(replacement.id, front.sessionId);
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: '原对话已恢复' })).toBeVisible();
  await expect(page.locator('.detail-head')).toContainText('进行中');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: artifact('lifecycle-pause-desktop.png'), fullPage: true });
});

test('390px 暂停失败保留进行中、说明原因并可重试', async ({ page, platform }) => {
  const { origin, password, api } = platform;
  await page.setViewportSize({ width: 390, height: 844 });
  const front = await api.foregroundActive();
  await api.foregroundControl();
  await login(page, origin, password, `/tasks/${front.taskId}`);

  await submitPause(page);
  const pause = await pauseDirective(platform, 'pause');
  await api.sessionReport(pause.id, { step: 'stop', result: 'failed', failure: 'session_stop_failed' });
  await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: '未能确认旧 Pi 进程已退出' })).toBeVisible();
  await expect(page.locator('.detail-head')).toContainText('暂停处理中');
  await expect(page.locator('.detail-head')).not.toContainText('已暂停');
  await expect(page.getByRole('button', { name: '重试暂停', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: artifact('lifecycle-pause-failure-mobile.png'), fullPage: true });

  await page.getByRole('button', { name: '重试暂停', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const retried = page.waitForResponse((candidate) =>
    candidate.url().endsWith('/session-operation') && candidate.request().method() === 'POST');
  await dialog.getByRole('button', { name: '暂停', exact: true }).click();
  const response = await retried;
  expect(response.status()).toBe(200);
  const retryDirective = await pauseDirective(platform, 'pause');
  await api.sessionReport(retryDirective.id, { step: 'stop', result: 'stopped' });
  await page.reload();
  await expect(page.locator('.detail-head')).toContainText('已暂停');
  await expect(page.getByRole('button', { name: '继续', exact: true })).toBeVisible();
});

test('结算提示、仅补记录版本与旧页不能越过最新版本', async ({ page, platform }) => {
  const { origin, password, api } = platform;
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, origin, password);
  const { task, attempt, delivery } = await runToDelivery(page, platform, '生命周期记录');

  await page.goto(`${origin}/tasks/${task.id}`);
  await expect(page.locator('.action-bar')).toContainText('本轮交付已保存，原 Pi 尚在收尾');
  await expect(page.getByRole('button', { name: '确认交付版本 · v1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '如何补充记录', exact: true }).click();
  const guide = page.getByRole('dialog');
  await expect(guide).toContainText('仅补记录');
  await expect(guide).toContainText('不重做代码、不重新部署、不重排任务');
  await expect(guide).toContainText('网页不会代为执行该工具');
  await guide.getByRole('button', { name: '返回', exact: true }).click();
  await expect(guide).toBeHidden();

  await api.settle(attempt.id);
  await page.reload();
  await expect(page.locator('.action-bar')).toContainText('本轮已结算，Pi 保留等待验收；无需手动退出。');
  await expect(page.getByRole('button', { name: '如何补充记录', exact: true })).toBeVisible();

  // 打开验收确认后，原 Pi 追加了补充记录；旧页仍提交 v1，必须被最新版本拒绝。
  await page.getByRole('button', { name: '确认交付版本 · v1', exact: true }).click();
  const confirm = page.getByRole('dialog');
  await api.reviseDelivery(attempt.id, delivery.deliveryId, '补充运行说明');
  const rejected = page.waitForResponse((candidate) => candidate.url().endsWith('/accept') && candidate.request().method() === 'POST');
  await confirm.getByRole('button', { name: '确认交付版本', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(confirm.getByRole('alert')).toContainText('任务已变化');
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '返回', exact: true }).click();
  await expect(confirm).toBeHidden();

  await page.reload();
  await expect(page.locator('.current-delivery')).toContainText('v2');
  await expect(page.locator('.current-delivery')).toContainText('补充记录');
  await expect(page.locator('.current-delivery')).toContainText('来源版本 · v1');
  await expect(page.locator('.current-delivery')).toContainText('补充运行说明');
  await expect(page.getByRole('button', { name: '确认交付版本 · v2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认交付版本 · v1', exact: true })).toHaveCount(0);
  await page.locator('summary').filter({ hasText: '历史版本' }).click();
  await expect(page.locator('.current-delivery')).toContainText('v1');
  await page.screenshot({ path: artifact('lifecycle-record-versions.png'), fullPage: true });
});

test('确认交付版本不直接报完成，无 Git 清理受阻仅保留清理重试', async ({ page, platform }) => {
  const { origin, password, api } = platform;
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page, origin, password);
  const { task, attempt } = await runToDelivery(page, platform, '生命周期清理');
  await api.settle(attempt.id);
  await page.goto(`${origin}/tasks/${task.id}`);
  await expect(page.locator('.action-bar')).toContainText('本轮已结算，Pi 保留等待验收');

  await page.getByRole('button', { name: '确认交付版本 · v1', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('只确认这一个交付版本，不代表最终完成');
  const accepted = page.waitForResponse((candidate) => candidate.url().endsWith('/accept') && candidate.request().method() === 'POST');
  await dialog.getByRole('button', { name: '确认交付版本', exact: true }).click();
  expect((await accepted).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(page.locator('.detail-head')).not.toContainText('已完成');

  // 测试启动器未声明会话控制能力，验收后的 finalize 只能进入清理受阻。
  await page.reload();
  await expect(page.locator('.detail-head')).toContainText('清理受阻');
  await expect(page.getByRole('button', { name: '重试清理', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '返修', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '如何补充记录', exact: true })).toHaveCount(0);

  await api.register(true);
  const retried = page.waitForResponse((candidate) => candidate.url().endsWith('/retry-git') && candidate.request().method() === 'POST');
  await page.getByRole('button', { name: '重试清理', exact: true }).click();
  expect((await retried).status()).toBe(200);
  const finalize = await pauseDirective(platform, 'finalize');
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: '正在停止专用 Pi 并确认退出' })).toBeVisible();
  await api.sessionReport(finalize.id, { step: 'stop', result: 'stopped' });
  await page.reload();
  await expect(page.locator('.detail-head')).toContainText('已完成');
  await expect(page.getByRole('button', { name: '重试清理', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑任务', exact: true })).toHaveCount(0);
  await page.screenshot({ path: artifact('lifecycle-cleanup-complete.png'), fullPage: true });
});
