import type { Page } from '@playwright/test';
import { webTaskMutationResponseSchema } from '@pi-steward/contract';
import { expect, projectId, test } from './platform-fixture';

async function login(page: Page, origin: string, password: string) {
  await page.goto(`${origin}/projects/${projectId}`);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
}

for (const width of [1280, 390]) {
  for (const reducedMotion of ['reduce', 'no-preference'] as const) {
    test(`表单真实Portal、DOM/Tab顺序与关闭回焦 ${width} ${reducedMotion}`, async ({ page, platform }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion });
      await login(page, platform.origin, platform.password);
      const trigger = page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true });
      const dialog = page.getByRole('dialog');
      for (const method of ['cancel', 'escape', 'close', 'overlay']) {
        await trigger.focus();
        await trigger.click();
        await expect(dialog).toHaveCSS('opacity', '1');
        expect(await dialog.evaluate(node => Boolean(node.closest('[data-portal]')?.parentElement === document.body))).toBe(true);
        const actions = dialog.locator('.pwa-confirm-actions button');
        await expect(actions).toHaveText(width < 768 ? ['创建任务', '返回'] : ['返回', '创建任务']);
        const first = await actions.nth(0).boundingBox();
        const second = await actions.nth(1).boundingBox();
        if (width < 768) expect(Math.round(first!.y + first!.height)).toBeLessThanOrEqual(Math.round(second!.y));
        else expect(Math.round(first!.x + first!.width)).toBeLessThanOrEqual(Math.round(second!.x));
        await actions.nth(0).focus();
        await page.keyboard.press('Tab');
        await expect(actions.nth(1)).toBeFocused();
        // 同一事件回合观察关闭后的DOM，不能以角色隐藏冒充真实退出。
        if (method === 'cancel') {
          expect(await dialog.getByRole('button', { name: '返回', exact: true }).evaluate(node => {
            (node as HTMLButtonElement).click();
            return Boolean(document.querySelector('[role="dialog"]'));
          })).toBe(true);
          if (reducedMotion === 'no-preference') await expect(dialog).toHaveCount(1);
        } else if (method === 'escape') await page.keyboard.press('Escape');
        else if (method === 'close') await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        else await page.locator('.mantine-Modal-overlay').click({ position: { x: 2, y: 2 } });
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
    });
  }
}

test('来源失效使用本地后备，退出不抢用户已转移的有效焦点', async ({ page, platform }) => {
  await login(page, platform.origin, platform.password);
  const trigger = page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true });
  await trigger.focus(); await trigger.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toHaveCSS('opacity', '1');
  await trigger.evaluate(node => { (node as HTMLButtonElement).disabled = true; });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('main')).toBeFocused();
  await trigger.evaluate(node => { (node as HTMLButtonElement).disabled = false; });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await trigger.click();
  await expect(dialog).toHaveCSS('opacity', '1');
  await dialog.getByRole('button', { name: '返回', exact: true }).click();
  // 等关闭态已提交、焦点陷阱释放后，模拟用户在退出期间转移焦点。
  await page.getByRole('main').focus();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('main')).toBeFocused();
});

for (const width of [390, 1280]) {
test(`确认成功移除来源后回到可见返回入口，确认顺序与Tab一致 ${width}`, async ({ page, platform }) => {
  await page.setViewportSize({ width, height: 900 });
  await login(page, platform.origin, platform.password);
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  await page.getByLabel('任务标题').fill('确认来源消失');
  await page.getByRole('dialog').getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认来源消失' })).toBeVisible();
  const trigger = page.getByRole('button', { name: '取消任务', exact: true });
  await trigger.focus(); await trigger.click();
  const dialog = page.getByRole('dialog');
  const actions = dialog.locator('.pwa-confirm-actions button');
  await expect(actions).toHaveText(width < 768 ? ['取消任务', '返回'] : ['返回', '取消任务']);
  await actions.first().focus(); await page.keyboard.press('Tab');
  await expect(actions.last()).toBeFocused();
  await dialog.getByRole('button', { name: '取消任务', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toHaveCount(0);
  const fallback = width < 768 ? page.locator('.mobile-topbar').getByRole('link', { name: '返回', exact: true }) : page.locator('.back-link');
  await expect(fallback).toBeVisible();
  await expect(fallback).toBeFocused();
});
}

for (const kind of ['create', 'edit', 'rework'] as const) {
  test(`忙态离开再返回同一目标，旧请求失败后可重试和返回 ${kind}`, async ({ page, platform }) => {
    const { origin, password, api } = platform;
    await login(page, origin, password);
    const response = await page.request.post(`${origin}/api/v1/web/tasks`, {
      headers: { Origin: origin }, data: { projectId, title: '导航中请求失败', goal: '', acceptance: '', notes: '', agent: 'pi', machineId: null, type: 'implementation' },
    });
    expect(response.status()).toBe(201);
    const task = webTaskMutationResponseSchema.parse(await response.json()).task;
    if (kind === 'rework') {
      await page.request.post(`${origin}/api/v1/web/tasks/${task.id}/schedule`, { headers: { Origin: origin }, data: {} });
      const attempt = await api.claim();
      if (!attempt) throw new Error('No attempt');
      await api.session(attempt.id, attempt.sessionId);
      await api.started(attempt.id);
      await api.deliver(attempt.id, '用于导航失败回归的交付');
      await api.exited(attempt.id);
    }
    await page.reload();
    await page.getByRole('link', { name: /导航中请求失败/ }).click();
    const open = kind === 'create' ? '新建任务' : kind === 'edit' ? '编辑任务' : '返修';
    await page.getByRole('button', { name: open, exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog');
    const field = kind === 'rework' ? '返修反馈' : kind === 'edit' ? '说明' : '任务标题';
    await dialog.getByRole('textbox', { name: field, exact: true }).fill('跨导航保留的输入');
    const path = `/api/v1/web/tasks${kind === 'create' ? '' : `/${task.id}${kind === 'rework' ? '/rework' : ''}`}`;
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived!: () => void;
    const pending = new Promise<void>(resolve => { arrived = resolve; });
    await page.route(`**${path}`, async route => {
      if (route.request().method() === 'GET') { await route.continue(); return; }
      requests += 1;
      if (requests === 1) { arrived(); await gate; }
      await route.abort('failed');
    });
    await dialog.locator('form').evaluate(node => { (node as HTMLFormElement).requestSubmit(); });
    await pending;
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await page.goForward();
    await expect(dialog.getByRole('button', { name: '返回', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: field, exact: true })).toHaveValue('跨导航保留的输入');
    release();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByRole('button', { name: '返回', exact: true })).toBeEnabled();
    await expect(dialog.getByRole('textbox', { name: field, exact: true })).toHaveValue('跨导航保留的输入');
    // 新实例必须真正解锁，同时同一回合仍只允许一次提交。
    await dialog.locator('form').evaluate(node => {
      (node as HTMLFormElement).requestSubmit();
      (node as HTMLFormElement).requestSubmit();
    });
    await expect.poll(() => requests).toBe(2);
    await expect(dialog.getByRole('alert')).toBeVisible();
    await dialog.getByRole('button', { name: '返回', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: open, exact: true }).filter({ visible: true }).click();
    await expect(dialog.getByRole('textbox', { name: field, exact: true })).toHaveValue('');
  });
}

test('表单忙态同步防双提、所有关闭门禁与失败保留草稿', async ({ page, platform }) => {
  await login(page, platform.origin, platform.password);
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务标题').fill('失败保留草稿');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let arrived!: () => void;
  const pending = new Promise<void>(resolve => { arrived = resolve; });
  let requests = 0;
  await page.route('**/api/v1/web/tasks', async route => {
    requests += 1; arrived(); await gate;
    await route.abort('failed');
  });
  await dialog.locator('form').evaluate(node => {
    (node as HTMLFormElement).requestSubmit();
    (node as HTMLFormElement).requestSubmit();
  });
  await pending;
  await page.keyboard.press('Escape');
  await page.locator('.mantine-Modal-overlay').click({ position: { x: 2, y: 2 } });
  await expect(dialog.getByRole('button', { name: '返回', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '关闭', exact: true })).toHaveCount(0);
  await expect(dialog).toBeVisible();
  expect(requests).toBe(1);
  release();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByLabel('任务标题')).toHaveValue('失败保留草稿');
  await dialog.getByRole('button', { name: '返回', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});
