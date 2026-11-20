import { createHash, randomBytes } from 'node:crypto';
import type { Page } from '@playwright/test';
import { createPairingResponseSchema, STEW_INSTALL_COMMAND, webTaskDetailResponseSchema, webTaskMutationResponseSchema } from '@pi-steward/contract';
import { artifact, expect, projectId, projectName, test } from './platform-fixture';

const title = '验证任务控制台交付流程';

async function signIn(page: Page, password: string) {
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
}

async function createTask(page: Page) {
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('任务标题').fill(title);
  await form.getByLabel('目标', { exact: true }).fill('通过网页完成一轮交付');
  await form.getByLabel('验收要求').fill('可以保存并重新打开任务');
  await form.getByRole('button', { name: '创建任务' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  return new URL(page.url()).pathname;
}

async function editWithConflict(page: Page, origin: string, taskPath: string) {
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  const form = page.getByRole('dialog');
  const localNotes = '从浏览器保留的编辑内容';
  await form.getByLabel('说明', { exact: true }).fill(localNotes);
  const endpoint = `${origin}/api/v1/web${taskPath}`;
  const response = await page.request.get(endpoint);
  const { task } = webTaskDetailResponseSchema.parse(await response.json());
  const external = await page.request.patch(endpoint, {
    headers: { Origin: origin }, data: { version: task.version, goal: '另一个客户端补充了目标' },
  });
  expect(external.status()).toBe(200);
  webTaskMutationResponseSchema.parse(await external.json());
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('输入已保留');
  await expect(form.getByLabel('说明', { exact: true })).toHaveValue(localNotes);
  await form.getByRole('button', { name: '核对最新版本并保留输入' }).click();
  await expect(form.getByLabel('目标', { exact: true })).toHaveValue('另一个客户端补充了目标');
  await form.getByRole('button', { name: '保存', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText(localNotes)).toBeVisible();
}

async function confirm(page: Page, action: string, feedback?: string) {
  const name = action === '验收通过' ? /^验收通过 · v\d+$/ : action;
  await page.getByRole('button', { name, exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (feedback) await dialog.getByLabel('返修反馈').fill(feedback);
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function reload(page: Page) {
  await page.reload();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
}

async function startPairing(page: Page, origin: string, name: string) {
  const token = `stm_${randomBytes(32).toString('base64url')}`;
  const response = await page.request.post(`${origin}/api/v1/pairing/create`, {
    headers: { Origin: origin }, data: { name, tokenHash: createHash('sha256').update(token).digest('hex') },
  });
  expect(response.status()).toBe(200);
  return createPairingResponseSchema.parse(await response.json());
}

test('接入网页展示首次步骤并从电脑页完成短码审批', async ({ page, platform }) => {
  const { origin, password } = platform;
  const machineName = '网页接入 Mac';
  const pairing = await startPairing(page, origin, machineName);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto(origin);
  await signIn(page, password);

  const guide = page.locator('details.onboarding');
  await expect(guide).not.toHaveAttribute('open', '');
  await guide.locator('summary').click();
  for (const command of [STEW_INSTALL_COMMAND, 'stew pair', 'stew start', 'stew add']) {
    await expect(guide.getByText(command, { exact: true })).toBeVisible();
  }
  const copyInstall = guide.getByRole('button', { name: `复制 ${STEW_INSTALL_COMMAND}` });
  await copyInstall.click();
  await expect(copyInstall).toContainText('已复制');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(STEW_INSTALL_COMMAND);

  await guide.getByRole('link', { name: '查看电脑' }).click();
  await expect(page).toHaveURL(`${origin}/machines`);
  await page.getByRole('link', { name: '接入新电脑' }).click();
  await expect(page).toHaveURL(`${origin}/pair`);

  await page.getByLabel('接入短码').fill('0000000000');
  await page.getByRole('button', { name: '检查短码' }).click();
  await expect(page.getByRole('alert')).toContainText('短码无效、已过期或已使用');
  await page.getByLabel('接入短码').fill(pairing.code);
  await page.getByRole('button', { name: '检查短码' }).click();
  const request = page.getByRole('region', { name: '接入请求' });
  await expect(request).toContainText(machineName);
  await expect(request).toContainText(pairing.code);
  await expect(request.getByRole('heading')).toBeFocused();
  await request.getByRole('button', { name: '确认接入', exact: true }).click();

  const success = page.getByRole('region', { name: '电脑已接入' });
  await expect(success).toContainText(machineName);
  await expect(success).toContainText('stew start');
  await expect(success.getByRole('heading')).toBeFocused();
  await success.getByRole('link', { name: '查看电脑' }).click();
  await expect(page.getByRole('heading', { name: machineName, exact: true })).toBeVisible();
});

test('手机从配对深链登录，已使用的短码不再允许确认', async ({ page, platform }) => {
  const { origin, password } = platform;
  const { code } = await startPairing(page, origin, '手机审批 Mac');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/pair`);
  await signIn(page, password);
  await expect(page).toHaveURL(`${origin}/pair`);
  const field = page.getByLabel('接入短码');
  await expect(field).toBeFocused();
  await field.fill(code);
  await field.press('Enter');
  const pending = page.getByRole('region', { name: '接入请求' });
  await expect(pending).toContainText('手机审批 Mac');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const consumed = await page.request.post(`${origin}/api/v1/web/pairing/approve`, { headers: { Origin: origin }, data: { code } });
  expect(consumed.status()).toBe(200);
  await pending.getByRole('button', { name: '确认接入', exact: true }).click();
  await expect(pending).toBeHidden();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('短码无效、已过期或已使用');
  await expect(field).toBeFocused();
  await alert.getByRole('link', { name: '查看电脑' }).click();
  await expect(page.getByRole('heading', { name: '手机审批 Mac', exact: true })).toBeVisible();
});

test('生产静态资源和页面入口保持各自的响应', async ({ request, platform }) => {
  const { origin } = platform;
  const ticket = 'a684b6a7-ab2e-45e2-81ba-1f8b42f6e774';
  for (const route of ['/', '/login', '/machines', `/projects/${projectId}`, `/tasks/${ticket}`]) {
    const response = await request.get(`${origin}${route}`);
    expect(response.status(), route).toBe(200);
    expect(response.headers()['content-type']).toContain('text/html');
  }
  for (const route of ['/assets/missing.js', '/tasks/missing.png', '/unknown']) {
    const response = await request.get(`${origin}${route}`);
    expect(response.status(), route).toBe(404);
    expect(response.headers()['content-type']).toContain('text/plain');
  }
  const unknownApi = await request.get(`${origin}/api/v1/undefined`);
  expect(unknownApi.status()).toBe(404);
  expect(await unknownApi.json()).toMatchObject({ error: { code: 'not_found' } });
  const manifest = await request.get(`${origin}/manifest.webmanifest`);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  expect(await manifest.json()).toMatchObject({ display: 'standalone', start_url: '/', scope: '/' });
  for (const size of [192, 512]) expect((await request.get(`${origin}/steward-${size}.png`)).headers()['content-type']).toContain('image/png');
});

test('桌面新建、编辑、安排、返修和验收，移动端登录后保留任务深链接', async ({ page, browser, platform }) => {
  const { origin, password, api } = platform;
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(origin);
  await signIn(page, password);
  await page.getByRole('main').getByRole('link', { name: new RegExp(projectName) }).click();
  const taskPath = await createTask(page);
  await editWithConflict(page, origin, taskPath);
  await page.getByRole('button', { name: '安排开始', exact: true }).click();
  await expect(page.getByText('等待启动器领取', { exact: true })).toBeVisible();
  await page.getByRole('main').getByRole('link', { name: projectName, exact: true }).click();
  const queued = page.getByRole('region', { name: '待领取', exact: true });
  await expect(queued.getByText('等待启动器领取')).toBeVisible();
  await page.screenshot({ path: artifact('steward-desktop-project.png') });
  await queued.getByRole('link', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  const first = await api.claim();
  if (!first) throw new Error('No first attempt claimed');
  await api.started(first.id);
  await api.progress(first.id, '正在检查详情与状态更新');
  // 等待 10 秒轮询可见进展，确认页面不需要手动刷新。
  await expect(page.getByText('正在检查详情与状态更新')).toBeVisible({ timeout: 13_000 });
  await api.deliver(first.id, '已完成任务详情检查');
  await reload(page);
  await confirm(page, '返修', '请补充刷新深链接的验证');
  await expect(page.getByText('上次执行仍在收尾')).toBeVisible();
  await api.exited(first.id);
  const second = await api.claim();
  if (!second) throw new Error('No rework attempt claimed');
  expect(second.sessionId).toBe(first.sessionId);
  await api.started(second.id);
  await api.deliver(second.id, '已补充深链接刷新验证');
  await api.exited(second.id);
  await reload(page);
  await page.screenshot({ path: artifact('steward-desktop.png'), fullPage: true });
  await confirm(page, '验收通过');
  await expect(page.locator('.status-done').getByText('已完成', { exact: true })).toBeVisible();
  const logoutPath = '**/api/v1/web/auth/logout';
  await page.route(logoutPath, (route) => route.abort());
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法连接平台，请重试。');
  await page.unroute(logoutPath);
  await page.getByRole('alert').getByRole('button').click();
  await expect(page.getByLabel('访问密码')).toBeVisible();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    colorScheme: 'light', locale: 'zh-CN', reducedMotion: 'reduce' });
  try {
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(`${origin}${taskPath}`);
    await signIn(mobilePage, password);
    await expect(mobilePage.getByRole('heading', { name: title })).toBeVisible();
    await expect(mobilePage).toHaveURL(`${origin}${taskPath}`);
    await reload(mobilePage);
    expect(await mobilePage.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await mobilePage.screenshot({ path: artifact('steward-mobile.png'), fullPage: true });
    await mobilePage.getByRole('link', { name: '返回', exact: true }).click();
    await expect(mobilePage.locator('details.task-group summary')).toContainText('已完成');
    await expect(mobilePage.locator('details.task-group')).not.toHaveAttribute('open', '');
    await mobilePage.screenshot({ path: artifact('steward-mobile-project.png') });
    await mobilePage.getByRole('button', { name: '打开菜单' }).click();
    const drawer = mobilePage.getByRole('dialog');
    await expect(drawer).toBeVisible();
    await mobilePage.screenshot({ path: artifact('steward-mobile-drawer.png') });
    await mobilePage.emulateMedia({ colorScheme: 'dark' });
    await expect(mobilePage.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
    await drawer.getByRole('button', { name: /外观/ }).click();
    await expect(mobilePage.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'light');
    await drawer.getByRole('button', { name: '切换语言' }).click();
    await drawer.getByRole('link', { name: /^Machines/ }).click();
    await expect(mobilePage.getByRole('heading', { name: 'Machines', exact: true })).toBeVisible();
    await expect(mobilePage.getByText('测试 Mac', { exact: true })).toBeVisible();
  } finally { await mobile.close(); }
});
