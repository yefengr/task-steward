import type { Locator, Page } from '@playwright/test';
import { expect, test } from './platform-fixture';

async function login(page: Page, platform: { origin: string; password: string }) {
  await page.goto(platform.origin);
  await page.getByLabel('访问密码').fill(platform.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
}

async function pointer(target: Locator, type: string, x = 20, y = 20) {
  await target.dispatchEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, button: 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, bubbles: true });
}

async function shortPress(target: Locator) {
  const box = (await target.boundingBox())!;
  await pointer(target, 'pointerdown', box.x + 12, box.y + 12);
  await pointer(target, 'pointerup', box.x + 12, box.y + 12);
  await expect(target).toHaveAttribute('data-pwa-pressed', 'true');
  await expect(target).not.toHaveAttribute('data-pwa-pressed');
  await expect(target).not.toHaveAttribute('data-pwa-press-release');
}

test.describe('宿主偏好与原生折叠', () => {
  test.use({ viewport: { width: 1280, height: 900 } });
  test('三档外观/字号持久化、系统回退、原生summary键盘和复制反馈', async ({ page, platform }) => {
    await login(page, platform);
    const navigation = page.locator('.sidebar');
    const appearance = navigation.getByLabel('外观', { exact: true });
    const size = navigation.getByLabel('字号', { exact: true });
    for (const scheme of ['light', 'dark', 'auto']) {
      await appearance.selectOption(scheme);
      await expect.poll(() => page.evaluate(() => localStorage.getItem('pi-steward-appearance'))).toBe(scheme);
      await page.reload();
      await expect(appearance).toHaveValue(scheme);
      await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', scheme === 'auto' ? 'light' : scheme);
    }
    for (const value of ['large', 'xlarge', 'standard']) {
      await size.selectOption(value);
      await page.reload();
      await expect(size).toHaveValue(value);
      await expect.poll(() => page.evaluate(() => localStorage.getItem('pi-steward-text-size'))).toBe(value);
      if (value === 'standard') await expect(page.locator('html')).not.toHaveAttribute('data-pwa-text-size');
      else await expect(page.locator('html')).toHaveAttribute('data-pwa-text-size', value);
    }
    // Chromium 不支持 -apple-system-body；存储的 system 仍须安全回退。
    if (await size.locator('option[value="system"]').count() === 0) {
      await page.evaluate(() => localStorage.setItem('pi-steward-text-size', 'system'));
      await page.reload();
      await expect(size).toHaveValue('standard');
      await expect(page.locator('html')).not.toHaveAttribute('data-pwa-text-size');
    } else {
      await size.selectOption('system');
      await page.reload();
      await expect(size).toHaveValue('system');
    }
    await page.evaluate(() => {
      localStorage.setItem('pi-steward-text-size', 'large');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(size).toHaveValue('large');
    await expect(page.locator('html')).toHaveAttribute('data-pwa-text-size', 'large');
    const fold = page.locator('details.onboarding');
    const summary = fold.locator('summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(fold).toHaveAttribute('open', '');
    await page.keyboard.press('Space');
    await expect(fold).not.toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => {} } }));
    const copy = fold.getByRole('button', { name: /^复制 / }).first();
    await copy.click();
    await expect(copy).toHaveText('已复制');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async () => { throw new Error('synthetic clipboard denial'); } } }));
    await copy.click();
    await expect(fold.getByRole('alert')).toHaveText('复制失败，请手动选择命令。');
  });

  test('存储异常不阻断启动或本次字号切换', async ({ page, platform }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('synthetic storage denial'); };
      Storage.prototype.setItem = () => { throw new Error('synthetic storage denial'); };
    });
    await login(page, platform);
    await page.locator('.sidebar').getByLabel('字号', { exact: true }).selectOption('xlarge');
    await expect(page.locator('html')).toHaveAttribute('data-pwa-text-size', 'xlarge');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('html')).toHaveAttribute('data-pwa-text-size', 'xlarge');
  });
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test.describe(`真实Drawer与触控反馈 ${reducedMotion}`, () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      contextOptions: { reducedMotion } });
    test('进出动画、Tab/Escape回焦与导航/summary短触和scroll撤销', async ({ page, platform }) => {
      await login(page, platform);
      const trigger = page.getByRole('button', { name: '打开菜单', exact: true });
      await trigger.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const expected = reducedMotion === 'reduce' ? '0.12s' : '0.36s';
      await expect(dialog).toHaveCSS('transition-duration', expected);
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
      const nav = dialog.getByRole('button', { name: '切换语言', exact: true });
      await shortPress(nav);
      const box = (await nav.boundingBox())!;
      await pointer(nav, 'pointerdown', box.x + 12, box.y + 12);
      await nav.dispatchEvent('scroll');
      await pointer(nav, 'pointerup', box.x + 12, box.y + 12);
      await expect(nav).not.toHaveAttribute('data-pwa-pressed');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      const summary = page.locator('details.onboarding > summary');
      await shortPress(summary);
      await summary.tap();
      await expect(page.locator('details.onboarding')).toHaveAttribute('open', '');
    });
  });
}

// 当前宿主没有 Menu/Popover，NativeSelect 使用原生下拉；outside guard 不适用。
