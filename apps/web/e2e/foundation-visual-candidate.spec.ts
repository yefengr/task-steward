import { webTaskMutationResponseSchema } from '@pi-steward/contract';
import { expect, projectId, test, artifact } from './platform-fixture';

for (const scheme of ['light', 'dark'] as const) {
  for (const mobile of [false, true]) {
    test.describe(`${scheme} ${mobile ? '触控' : '桌面'}视觉候选`, () => {
      test.use({ colorScheme: scheme, viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
        isMobile: mobile, hasTouch: mobile });
      test('真实侧栏/时间线/顶栏消费公共基础且不改变输入焦点与命中区', async ({ page, platform }) => {
        const { origin, password } = platform;
        await page.goto(`${origin}/projects/${projectId}`);
        await expect(page.locator('.login-card')).toHaveCSS('padding-top', '24px');
        await page.getByLabel('访问密码').fill(password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await expect(page.getByLabel('访问密码')).toBeHidden();
        const response = await page.request.post(`${origin}/api/v1/web/tasks`, { headers: { Origin: origin }, data: {
          projectId, title: '视觉基础验收', goal: '验证公共视觉与任务领域分离', acceptance: '界面与操作保持可用',
          notes: '', agent: 'pi', machineId: null, type: 'implementation',
        } });
        expect(response.status()).toBe(201);
        const task = webTaskMutationResponseSchema.parse(await response.json()).task;
        await page.request.post(`${origin}/api/v1/web/tasks/${task.id}/schedule`, { headers: { Origin: origin }, data: {} });
        await page.reload();
        const row = page.getByRole('link', { name: /视觉基础验收/ });
        await expect(row).toHaveCSS('padding-left', '12px');
        await expect(row).toHaveCSS('row-gap', '2px');
        await expect(row.locator('.row-sub')).toHaveCSS('column-gap', '8px');
        await expect(row).toHaveCSS('border-radius', '8px');
        await expect(row).toHaveCSS('box-shadow', 'none');
        await row.click();
        await expect(page.locator('.detail-head h1')).toHaveCSS('margin-bottom', '4px');
        await page.locator('.detail-section.fold').last().locator('summary').first().click();
        await expect(page.locator('.detail-section.fold').last().locator('.fold-body')).toHaveCSS('padding-inline-start', '16px');
        const separator = page.locator('.timeline li:not(:last-child)').first();
        await expect(separator).toBeVisible();
        await expect(separator).toHaveCSS('border-bottom-width', '1px');
        const initialColor = await separator.evaluate(node => getComputedStyle(node).borderBottomColor);
        await page.locator('html').evaluate(node => node.setAttribute('data-pwa-hairline', ''));
        await expect.poll(() => separator.evaluate(node => getComputedStyle(node).borderBottomColor)).not.toBe(initialColor);
        await page.locator('html').evaluate(node => node.removeAttribute('data-pwa-hairline'));
        if (mobile) {
          const bar = page.locator('.mobile-topbar');
          expect(Math.round((await bar.boundingBox())!.height)).toBe(48);
          await expect(bar).toHaveCSS('border-bottom-color', initialColor);
          await page.locator('html').evaluate(node => node.style.setProperty('--pwa-safe-top', '20px'));
          expect(Math.round((await bar.boundingBox())!.height)).toBe(68);
          await page.locator('html').evaluate(node => node.style.removeProperty('--pwa-safe-top'));
          const menu = page.getByRole('button', { name: '打开菜单', exact: true });
          expect(Math.round((await menu.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
        } else {
          const panel = page.locator('.sidebar');
          await expect(panel).toHaveCSS('border-radius', '16px');
          await expect(panel).toHaveCSS('border-top-width', '1px');
          const shadow = await panel.evaluate(node => getComputedStyle(node).boxShadow);
          expect(shadow === 'none').toBe(scheme === 'dark');
          await expect(page.locator('.sidebar-footer')).toHaveCSS('border-top-color', initialColor);
        }
        await page.screenshot({ path: artifact(`visual-candidate-${scheme}-${mobile ? 'mobile' : 'desktop'}.png`) });
        await page.getByRole('button', { name: '编辑任务', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await expect(dialog).toHaveCSS('border-top-width', '0px');
        const input = dialog.getByRole('textbox', { name: '任务标题', exact: true });
        await input.focus();
        await expect(input).toHaveCSS('border-top-width', '1px');
        await expect(input).toHaveCSS('outline-width', '2px');
        expect(Math.round((await input.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        await expect(page.getByRole('button', { name: '编辑任务', exact: true })).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      });
    });
  }
}
