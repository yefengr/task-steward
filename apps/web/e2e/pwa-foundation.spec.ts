import { expect, projectId, test } from './platform-fixture';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

test('生产页面：移动主区避让安全区，任务表单的电脑下拉保持锚点并可保存', async ({ page, platform }) => {
  await page.goto(`${platform.origin}/projects/${projectId}`);
  await page.getByLabel('访问密码').fill(platform.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page).toHaveURL(`${platform.origin}/projects/${projectId}`);
  const html = page.locator('html');
  expect(await html.evaluate((node) => {
    const style = getComputedStyle(node);
    return ['--pwa-safe-right', '--pwa-hit-target'].map((property) => style.getPropertyValue(property).trim());
  })).toEqual(['0px', '44px']);

  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole('dialog');
  const select = dialog.getByLabel('执行电脑', { exact: true });
  const safeRight = 96;
  await html.evaluate((node, inset) => {
    node.style.setProperty('--pwa-safe-right', `${inset}px`);
    window.dispatchEvent(new Event('resize'));
  }, safeRight);
  await expect(page.locator('main')).toHaveCSS('padding-right', `${safeRight}px`);
  const screenLimit = await page.evaluate((inset) => window.innerWidth - inset, safeRight);
  const box = await select.boundingBox();
  const anchorRight = Math.round(box!.x + box!.width);
  // 新公共Modal已先按安全区内缩，Select仍须与这个锚点对齐，而不是要求输入框先越过安全区。
  expect(anchorRight).toBeLessThanOrEqual(screenLimit);

  await select.click();
  const option = page.getByRole('option', { name: '测试 Mac', exact: true });
  await expect(option).toBeVisible();
  const dropdown = page.locator('.mantine-Select-dropdown');
  // Select 默认与锚点同宽，上下定位时 Mantine 不启用横向 shift。
  await expect.poll(async () => {
    const bounds = await dropdown.boundingBox();
    return bounds ? Math.round(bounds.x + bounds.width) : null;
  }).toBe(anchorRight);
  await option.click();
  await expect(dropdown).toBeHidden();
  await expect(select).toHaveValue('测试 Mac');

  const title = '验证公开包的电脑选择';
  await dialog.getByLabel('任务标题').fill(title);
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  await expect(page.getByRole('dialog').getByLabel('执行电脑', { exact: true })).toHaveValue('测试 Mac');
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();
  await expect(dialog).toBeHidden();
});
