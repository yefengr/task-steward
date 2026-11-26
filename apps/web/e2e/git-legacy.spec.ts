import { DatabaseSync } from 'node:sqlite';
import { webTaskDetailResponseSchema } from '@pi-steward/contract';
import { expect, projectId, test } from './platform-fixture';

test('升级前已开工的中断任务可以明确补第一次基准分支并保存', async ({ page, platform }) => {
  await page.goto(platform.origin);
  await page.getByLabel('访问密码').fill(platform.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('访问密码')).toBeHidden();
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('任务标题').fill('升级前已开工任务');
  await dialog.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(page.getByRole('heading', { name: '升级前已开工任务' })).toBeVisible();
  const taskPath = new URL(page.url()).pathname;
  const taskId = taskPath.split('/').at(-1)!;
  await page.getByRole('button', { name: '安排开始', exact: true }).click();
  const attempt = await platform.api.claim();
  expect(attempt?.taskId).toBe(taskId);
  await platform.api.started(attempt!.id);
  await platform.api.exited(attempt!.id);

  const database = new DatabaseSync(platform.databaseFile);
  try {
    // 旧任务经历迁移后新增列仍为 NULL；模拟该持久状态，不借助新版本领取时的冻结标志。
    database.prepare('UPDATE tasks SET base_branch=NULL, git_sync_before_start=NULL WHERE id=?').run(taskId);
    const settings = await page.request.patch(`${platform.origin}/api/v1/web/projects/${projectId}/git`, {
      headers: { Origin: platform.origin }, data: { version: 1, baseBranch: 'main', syncBeforeStart: false },
    });
    expect(settings.status()).toBe(200);
    await page.reload();
    await page.getByRole('button', { name: '编辑任务', exact: true }).click();
    dialog = page.getByRole('dialog');
    const input = dialog.getByLabel('任务基准分支');
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('');
    await expect(dialog).toContainText('同步选项以保存时项目当前设置为准');
    await input.fill('main');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).toBeHidden();

    const response = await page.request.get(`${platform.origin}/api/v1/web${taskPath}`);
    const { task } = webTaskDetailResponseSchema.parse(await response.json());
    expect(task).toMatchObject({ status: 'interrupted', baseBranch: 'main', git: null });
    expect(database.prepare('SELECT base_branch, git_sync_before_start FROM tasks WHERE id=?').get(taskId))
      .toEqual({ base_branch: 'main', git_sync_before_start: 0 });
    await page.getByRole('button', { name: '编辑任务', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('任务基准分支')).toBeDisabled();
    await expect(page.getByRole('dialog').getByLabel('任务基准分支')).toHaveValue('main');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '重新安排', exact: true }).click();
    await expect(page.getByRole('button', { name: '撤回', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '编辑任务', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('任务基准分支')).toBeDisabled();
    await expect(page.getByRole('dialog').getByLabel('任务基准分支')).toHaveValue('main');
  } finally { database.close(); }
});
