import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from './platform-fixture';

for (const width of [390, 1280]) {
  test(`外观与字号选项在三档文字及双主题保持可达 ${width}`, async ({ page, platform }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(platform.origin);
    await page.getByLabel('访问密码').fill(platform.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByLabel('访问密码')).toBeHidden();
    if (width < 768) await page.getByRole('button', { name: '打开菜单', exact: true }).click();
    const nav = width < 768 ? page.getByRole('dialog') : page.locator('.sidebar');
    for (const scheme of ['light', 'dark']) {
      await nav.getByLabel('外观', { exact: true }).selectOption(scheme);
      for (const size of ['standard', 'large', 'xlarge']) {
        await nav.getByLabel('字号', { exact: true }).selectOption(size);
        const logout = nav.getByRole('button', { name: '退出登录', exact: true });
        await logout.scrollIntoViewIfNeeded();
        await expect(logout).toBeInViewport();
        await expect(nav.getByLabel('字号', { exact: true })).toBeInViewport();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        expect(overflow).toBe(false);
        for (const label of ['外观', '字号']) {
          const field = nav.getByLabel(label, { exact: true });
          const box = (await field.boundingBox())!;
          expect(Math.round(box.height)).toBeGreaterThanOrEqual(44);
          expect(Math.round(box.x)).toBeGreaterThanOrEqual(0);
          expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(width);
        }
      }
    }
    const evidence = path.resolve('../../.pi/tmp/steward-web-e2e');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, `preferences-dark-xlarge-${width}.png`) });
  });
}
