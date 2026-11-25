import type { Page } from '@playwright/test';
import { webTaskMutationResponseSchema } from '@pi-steward/contract';
import { expect, projectId, projectName, test } from './platform-fixture';

async function login(page: Page, origin: string, password: string, path = `/projects/${projectId}`) {
  await page.goto(origin + path);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
}
async function create(page: Page, origin: string, title: string) {
  const response = await page.request.post(`${origin}/api/v1/web/tasks`, {
    headers: { Origin: origin }, data: { projectId, title, goal: '完整目标', acceptance: '验收要求', notes: '', agent: 'pi', machineId: null, type: 'implementation' },
  });
  expect(response.status()).toBe(201);
  return webTaskMutationResponseSchema.parse(await response.json()).task;
}

test('问题前置、最新交付确认ID与失败返修跨导航和视口恢复', async ({ page, platform }) => {
  const { origin, password, api } = platform;
  await login(page, origin, password);
  const task = await create(page, origin, '核心任务');
  await page.request.post(`${origin}/api/v1/web/tasks/${task.id}/schedule`, { headers: { Origin: origin }, data: {} });
  const attempt = await api.claim();
  if (!attempt) throw new Error('No attempt');
  await api.session(attempt.id, attempt.sessionId);
  await api.started(attempt.id);
  await api.question(attempt.id, '请确认下一步');
  await api.progress(attempt.id, '较早的进展');
  await api.progress(attempt.id, '最新进展');
  await page.reload();
  await page.getByRole('link', { name: /核心任务/ }).click();
  await expect(page.getByRole('heading', { name: '请确认下一步' })).toBeVisible();
  await expect(page.locator('.callout').filter({ hasText: '请确认下一步' })).toContainText('请回原 Pi 会话回复');
  await expect(page.locator('.callout').filter({ hasText: '请确认下一步' })).toContainText('来自讨论任务的显式问题');
  const question = await page.getByRole('heading', { name: '请确认下一步' }).boundingBox();
  const progress = await page.getByRole('heading', { name: '当前进展' }).boundingBox();
  expect(question!.y).toBeLessThan(progress!.y);
  await expect(page.getByText('最新进展', { exact: true })).toBeVisible();
  await expect(page.getByText('较早的进展', { exact: true })).toBeHidden();
  await page.locator('summary').filter({ hasText: '更早进展' }).click();
  await expect(page.getByText('较早的进展', { exact: true })).toBeVisible();
  const delivery = await api.deliver(attempt.id, '完整最新交付');
  await api.exited(attempt.id);
  await page.goBack();
  await page.goForward();
  await expect(page.getByRole('button', { name: '验收通过 · v1' })).toBeVisible();
  const delivered = await page.locator('.current-delivery').boundingBox();
  const progressed = await page.locator('.current-progress').boundingBox();
  expect(delivered!.y).toBeLessThan(progressed!.y);
  await page.getByRole('button', { name: '返修', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '返修', exact: true }).click();
  await expect(dialog.getByLabel('返修反馈')).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByLabel('返修反馈').fill('保留的反馈');
  let sent: unknown;
  await page.route('**/api/v1/web/tasks/*/rework', async (route) => {
    sent = route.request().postDataJSON();
    await route.abort('failed');
  }, { times: 1 });
  await dialog.getByRole('button', { name: '返修', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  expect(sent).toEqual({ deliveryId: delivery.deliveryId, feedback: '保留的反馈' });
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.goForward();
  await expect(page.getByRole('dialog').getByLabel('返修反馈')).toHaveValue('保留的反馈');
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('dialog').getByLabel('返修反馈')).toHaveValue('保留的反馈');
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '验收通过 · v1' }).click();
  const request = page.waitForRequest('**/api/v1/web/tasks/*/accept');
  await page.getByRole('dialog').getByRole('button', { name: '验收通过', exact: true }).click();
  expect((await request).postDataJSON()).toEqual({ deliveryId: delivery.deliveryId });
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('项目折叠和异步列表滚动恢复，手机深链可返回且可打开导航', async ({ page, platform }) => {
  const { origin, password } = platform;
  await login(page, origin, password);
  for (let i = 0; i < 18; i += 1) {
    const task = await create(page, origin, `列表任务 ${i}`);
    await page.request.post(`${origin}/api/v1/web/tasks/${task.id}/cancel`, { headers: { Origin: origin }, data: {} });
  }
  const active = await create(page, origin, '活动深链任务');
  await page.reload();
  const group = page.locator('details.task-group');
  await group.locator('summary').click();
  const row = page.getByRole('link', { name: /列表任务 17/ });
  await row.scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => window.scrollY);
  expect(scroll).toBeGreaterThan(100);
  await row.click();
  await expect(page.getByRole('heading', { name: '列表任务 17' })).toBeVisible();
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
  await page.goBack();
  await expect(group).toHaveAttribute('open', '');
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('manual');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeCloseTo(scroll, -1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/tasks/${active.id}`);
  await expect(page.getByRole('heading', { name: '活动深链任务' })).toBeVisible();
  await page.getByRole('button', { name: '打开菜单' }).click();
  await expect(page.getByRole('dialog').getByRole('link', { name: new RegExp(projectName) })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('link', { name: '返回', exact: true }).click();
  await expect(page).toHaveURL(`${origin}/projects/${projectId}`);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.getByRole('navigation').getByRole('link', { name: '项目', exact: true }).click();
  await expect(page).toHaveURL(origin + '/');
  expect(await page.evaluate(() => history.scrollRestoration)).toBe('auto');
});

test('编辑和新建草稿按目标隔离，取消清理且导航返回不丢输入', async ({ page, platform }) => {
  const { origin, password } = platform;
  await login(page, origin, password);
  const first = await create(page, origin, '草稿任务一');
  await create(page, origin, '草稿任务二');
  await page.reload();
  await page.getByRole('link', { name: /草稿任务一/ }).click();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await page.getByLabel('说明', { exact: true }).fill('内存编辑草稿');
  await page.goBack();
  await page.getByRole('link', { name: /草稿任务二/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.goBack();
  await page.getByRole('link', { name: /草稿任务一/ }).click();
  await expect(page.getByLabel('说明', { exact: true })).toHaveValue('内存编辑草稿');
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await expect(page.getByLabel('说明', { exact: true })).toHaveValue('');
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  await page.goBack();
  await page.getByRole('navigation').getByRole('link', { name: '项目', exact: true }).click();
  await page.getByRole('main').getByRole('link', { name: new RegExp(projectName) }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  await page.getByLabel('任务标题').fill('新建草稿');
  await page.goBack();
  await page.goForward();
  await expect(page.getByLabel('任务标题')).toHaveValue('新建草稿');
  expect(first.id).toBeTruthy();
});

test('保存与取消真正清理表单快照，迟到创建不劫持当前路由', async ({ page, platform }) => {
  const { origin, password } = platform;
  await login(page, origin, password);
  const task = await create(page, origin, '重开编辑');
  await page.reload();
  await page.getByRole('link', { name: /重开编辑/ }).click();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await page.getByLabel('说明', { exact: true }).fill('已保存正文');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await expect(page.getByLabel('说明', { exact: true })).toHaveValue('已保存正文');
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await page.getByLabel('说明', { exact: true }).fill('应丢弃');
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  const endpoint = `${origin}/api/v1/web/tasks/${task.id}`;
  const current = await (await page.request.get(endpoint)).json() as { task: { version: number } };
  const updated = await page.request.patch(endpoint, { headers: { Origin: origin }, data: { version: current.task.version, notes: '外部最新正文' } });
  expect(updated.status()).toBe(200);
  await page.goBack();
  await page.goForward();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await expect(page.getByLabel('说明', { exact: true })).toHaveValue('外部最新正文');
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  await page.goBack();
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  await page.getByLabel('任务标题').fill('迟到创建');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let arrived!: () => void;
  const pending = new Promise<void>((resolve) => { arrived = resolve; });
  await page.route('**/api/v1/web/tasks', async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole('dialog').getByRole('button', { name: '创建任务', exact: true }).click();
  await pending;
  await page.goForward(); // 原任务页面，不属于迟到的新建操作。
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await page.getByLabel('说明', { exact: true }).fill('另一个目标的草稿');
  const response = page.waitForResponse((result) => result.url().endsWith('/api/v1/web/tasks') && result.request().method() === 'POST');
  release();
  await response;
  await expect(page.getByRole('dialog').getByLabel('说明', { exact: true })).toHaveValue('另一个目标的草稿');
  await expect(page).toHaveURL(`${origin}/tasks/${task.id}`);
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  await page.goBack();
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  await expect(page.getByLabel('任务标题')).toHaveValue('');
});
