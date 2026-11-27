import { webTaskDetailResponseSchema, webTaskMutationResponseSchema } from '@pi-steward/contract';
import { artifact, expect, projectId, test } from './platform-fixture';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`任务属性 ${viewport.width}px`, () => {
    test.use({ viewport });
    test('创建、冲突编辑、日期与中英展示，列表不随优先级重排', async ({ page, platform }) => {
      const { origin, password } = platform;
      await page.goto(`${origin}/projects/${projectId}`);
      await page.getByLabel('访问密码').fill(password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await expect(page.getByLabel('访问密码')).toBeHidden();
      const headers = { Origin: origin };
      const olderResponse = await page.request.post(`${origin}/api/v1/web/tasks`, {
        headers, data: { projectId, title: '较早的低优先级任务', priority: 'low' },
      });
      expect(olderResponse.status()).toBe(201);
      const older = webTaskMutationResponseSchema.parse(await olderResponse.json()).task;
      expect(older.difficulty).toBe('unassessed');
      await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
      const form = page.getByRole('dialog');
      await expect(form.getByLabel('优先级', { exact: true })).toHaveValue('normal');
      await expect(form.getByLabel('难易程度', { exact: true })).toHaveValue('unassessed');
      await expect(form.getByLabel('优先级', { exact: true }).locator('option')).toHaveText(['高', '普通', '低']);
      await expect(form.getByLabel('难易程度', { exact: true }).locator('option')).toHaveText(['未评估', '简单', '中等', '复杂']);
      await form.getByLabel('任务标题').fill('任务属性浏览器验收');
      await form.getByLabel('优先级', { exact: true }).selectOption('high');
      await form.getByLabel('难易程度', { exact: true }).selectOption('medium');
      await expect(form.getByText(/不是预计耗时/)).toBeVisible();
      await page.screenshot({ path: artifact(`attributes-form-zh-${viewport.width}.png`), fullPage: true });
      const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/web/tasks') && response.request().method() === 'POST');
      await form.getByRole('button', { name: '创建任务', exact: true }).click();
      const task = webTaskMutationResponseSchema.parse(await (await saved).json()).task;
      expect(task).toMatchObject({ status: 'unscheduled', priority: 'high', difficulty: 'medium' });
      await expect(page.getByRole('heading', { name: task.title, exact: true })).toBeVisible();
      const head = page.locator('.detail-head');
      await expect(head).toContainText('优先级 · 高');
      await expect(head).toContainText('难易程度 · 中等');
      const created = head.locator('.task-created-at time');
      await expect(created).toHaveAttribute('datetime', new Date(task.createdAt).toISOString());
      const fullDate = await page.evaluate(value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(value), task.createdAt);
      await expect(created).toHaveText(fullDate);

      await page.getByRole('button', { name: '编辑任务', exact: true }).click();
      await form.getByLabel('优先级', { exact: true }).selectOption('low');
      const endpoint = `${origin}/api/v1/web/tasks/${task.id}`;
      const external = await page.request.patch(endpoint, { headers, data: { version: task.version, difficulty: 'complex' } });
      expect(external.status()).toBe(200);
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect(form.getByRole('alert')).toContainText('输入已保留');
      await form.getByText('平台当前内容').click();
      await expect(form.locator('.conflict-preview')).toContainText('复杂');
      await form.getByRole('button', { name: '核对最新版本并保留输入' }).click();
      await expect(form.getByLabel('优先级', { exact: true })).toHaveValue('low');
      await expect(form.getByLabel('难易程度', { exact: true })).toHaveValue('complex');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect(form).toBeHidden();
      const latest = webTaskDetailResponseSchema.parse(await (await page.request.get(endpoint)).json()).task;
      expect(latest).toMatchObject({ priority: 'low', difficulty: 'complex', status: 'unscheduled', createdAt: task.createdAt });
      // 再次仅编辑优先级，验证未改动难度不会被默认值覆盖。
      await page.getByRole('button', { name: '编辑任务', exact: true }).click();
      await form.getByLabel('优先级', { exact: true }).selectOption('high');
      await form.getByRole('button', { name: '保存', exact: true }).click();
      await expect(form).toBeHidden();
      await expect(head).toContainText('难易程度 · 复杂');
      await page.screenshot({ path: artifact(`attributes-detail-zh-${viewport.width}.png`), fullPage: true });
      if (viewport.width < 768) await page.getByRole('link', { name: '返回', exact: true }).click();
      else await page.locator('.back-link').click();
      const rows = page.locator('.task-group[aria-label="未安排"] .row');
      await expect(rows.locator('.row-title')).toHaveText([older.title, task.title]);
      await expect(rows.nth(1)).toContainText('优先级 · 高');
      const date = await page.evaluate(value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short' }).format(value), task.createdAt);
      await expect(rows.nth(1).locator('.task-created-at time')).toHaveText(date);
      await page.screenshot({ path: artifact(`attributes-list-zh-${viewport.width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

      if (viewport.width < 768) await page.getByRole('button', { name: '打开菜单', exact: true }).click();
      await page.getByRole('button', { name: '切换语言', exact: true }).filter({ visible: true }).click();
      if (viewport.width < 768) await page.keyboard.press('Escape');
      const englishRow = page.getByRole('link', { name: new RegExp(task.title) });
      await expect(englishRow).toContainText('Priority · High');
      await expect(englishRow).toContainText('Difficulty · Complex');
      await expect(englishRow).toContainText('Created');
      await englishRow.click();
      await expect(head).toContainText('Priority · High');
      await expect(head).toContainText('Difficulty · Complex');
      await expect(head.locator('.task-created-at time')).toHaveText(await page.evaluate(value =>
        new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(value), task.createdAt));
      await page.getByRole('button', { name: 'Edit task', exact: true }).click();
      await expect(form.getByLabel('Priority', { exact: true })).toHaveValue('high');
      await expect(form.getByLabel('Difficulty', { exact: true })).toHaveValue('complex');
      await form.getByLabel('Difficulty', { exact: true }).focus();
      await expect(form.getByLabel('Difficulty', { exact: true })).toBeFocused();
      await page.screenshot({ path: artifact(`attributes-form-en-${viewport.width}.png`), fullPage: true });
      await page.keyboard.press('Escape');
      await expect(form).toBeHidden();
      await expect(page.getByRole('button', { name: 'Edit task', exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}
