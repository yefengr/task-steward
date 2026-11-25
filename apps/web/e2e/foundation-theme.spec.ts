import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, artifact, projectId, test } from './platform-fixture';
import type { Page } from '@playwright/test';

async function login(page: Page, origin: string, password: string) {
  await page.goto(`${origin}/projects/${projectId}`);
  await page.getByLabel('访问密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`公开主题 ${scheme}`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
    test('真实页面消费npm主题、输入和Modal默认值，保持焦点约束和Escape关闭', async ({ page, platform }) => {
      const require = createRequire(import.meta.url);
      const resolved = require.resolve('@yefengr/pwa-foundation/mantine');
      expect(resolved).toContain('@yefengr+pwa-foundation@0.0.2');
      const css = readFileSync(new URL('../src/pwa-theme.css', import.meta.url), 'utf8');
      expect(css).not.toMatch(/--pwa-(?:font-ui|text-body|radius-2xl|tonal|duration-modal-in)\s*:/);
      await login(page, platform.origin, platform.password);
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme);
      const trigger = page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true });
      await trigger.focus();
      await expect(trigger).toHaveCSS('min-height', '36px');
      await trigger.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toHaveCSS('border-radius', '24px');
      await expect(dialog).toHaveCSS('padding-top', '24px');
      await expect(dialog).toHaveCSS('background-color', scheme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(45, 45, 45)');
      const title = dialog.getByRole('textbox', { name: '任务标题', exact: true });
      await expect(title).toHaveCSS('font-size', '16px');
      expect(Math.round((await title.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
      const cancel = dialog.getByRole('button', { name: '返回', exact: true });
      const close = dialog.getByRole('button', { name: '关闭', exact: true });
      await close.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(cancel).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(close).toBeFocused();
      await expect(cancel).toHaveAttribute('data-variant', 'default');
      await expect(cancel).toHaveCSS('background-color', scheme === 'light' ? 'rgb(235, 235, 235)' : 'rgb(64, 64, 64)');
      await expect(dialog).toHaveCSS('opacity', '1');
      await page.screenshot({ path: artifact(`foundation-002-${scheme}-desktop.png`) });
      await cancel.click();
      await expect(dialog).toBeHidden();
      // 此宿主原先就条件挂载opened=true的Modal，回焦仍受应用生命周期限制；不把本次主题接入扩为生命周期修复。
      await trigger.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
    });
  });
}

test.describe('触控页面与确认布局', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('共享触控字号、胶囊按钮、确认顺序和直角Drawer', async ({ page, platform }) => {
    await login(page, platform.origin, platform.password);
    await expect(page.locator('body')).toHaveCSS('font-size', '17px');
    await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCSS('border-radius', '24px');
    await expect(dialog).toHaveCSS('padding-top', '16px');
    const title = dialog.getByRole('textbox', { name: '任务标题', exact: true });
    await expect(title).toHaveCSS('font-size', '17px');
    const confirm = dialog.getByRole('button', { name: '创建任务', exact: true });
    const cancel = dialog.getByRole('button', { name: '返回', exact: true });
    await expect(confirm).toHaveCSS('min-height', '44px');
    await expect(confirm).toHaveCSS('border-radius', '22px');
    await expect(dialog.locator('.pwa-confirm-actions')).toHaveCSS('flex-direction', 'column');
    const buttons = dialog.locator('.pwa-confirm-actions button');
    await expect(buttons.first()).toHaveText('创建任务');
    const first = await confirm.boundingBox();
    const last = await cancel.boundingBox();
    expect(Math.round(first!.y + first!.height)).toBeLessThanOrEqual(Math.round(last!.y));
    expect(Math.round(first!.width)).toBe(Math.round(last!.width));
    await page.locator('html').evaluate(node => { node.dataset.pwaTextSize = 'xlarge'; });
    await expect(title).toHaveCSS('font-size', '21px');
    await page.locator('html').evaluate(node => { delete node.dataset.pwaTextSize; });
    await cancel.click();
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: '打开菜单', exact: true }).click();
    const navigation = page.getByRole('dialog');
    await expect(navigation).toHaveCSS('border-radius', '0px');
    await expect(navigation).toHaveCSS('opacity', '1');
    await page.screenshot({ path: artifact('foundation-002-mobile-drawer.png') });
    await navigation.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(navigation).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
