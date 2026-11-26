import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Delivery, ProjectGitSettings, Task, TaskGit, WebProject } from '@pi-steward/contract';

// 该用例只验证 Web 端接线，使用独立静态服务与路由 mock，不依赖真实平台实现。
const dist = fileURLToPath(new URL('../dist', import.meta.url));
const projectId = 'git-demo';
const projectName = 'Git 演示项目';
const baseCommit = '1'.repeat(40);
const approvedCommit = '2'.repeat(40);
const mergedCommit = '3'.repeat(40);
const awaitingId = randomUUID();
const blockedId = randomUUID();
const queuedId = randomUUID();
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

async function startStaticServer() {
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const target = normalize(join(dist, extname(pathname) ? pathname : '/index.html'));
    const fallback = () => readFile(join(dist, 'index.html')).then((body) => {
      response.writeHead(200, { 'content-type': contentTypes['.html'] }).end(body);
    });
    if (!target.startsWith(dist)) { response.writeHead(403).end(); return; }
    try {
      const body = await readFile(target);
      response.writeHead(200, { 'content-type': contentTypes[extname(target)] ?? 'application/octet-stream' }).end(body);
    } catch { await fallback(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the static test server');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

function makeGit(phase: TaskGit['phase'], overrides: Partial<TaskGit> = {}): TaskGit {
  return {
    baseBranch: 'main', baseCommit, taskBranch: phase === 'awaiting_merge' ? 'feature/await' : 'feature/cleanup',
    repositoryPath: '/tmp/git-demo', worktreePath: '/tmp/git-demo-worktree', machineId: randomUUID(),
    syncBeforeStart: true, syncResult: 'synced', phase, operationId: randomUUID(), deliveryId: randomUUID(),
    approvedCommit, mergedCommit: null, message: null, ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: randomUUID(), projectId, title: 'Git 任务', goal: '', acceptance: '', notes: '', agent: 'pi',
    machineId: null, type: 'implementation', baseBranch: null, status: 'queued', reworkPending: false,
    position: 1, createdBy: 'user', version: 1, createdAt: 1, updatedAt: 1, waiting: null,
    needsVerification: false, needsResponse: false, discussionEndRequested: false, git: null, ...overrides,
  };
}

const awaitingTask = makeTask({
  id: awaitingId, title: '等待合并任务', status: 'review', position: 1, version: 2,
  git: makeGit('awaiting_merge', { message: '已验收，等待本机完成快进合并。' }),
});
const blockedTask = makeTask({
  id: blockedId, title: '清理受阻任务', status: 'review', position: 2, version: 3,
  git: makeGit('cleanup_blocked', { mergedCommit, message: '任务工作树仍有未提交改动。' }),
});
const queuedTask = makeTask({ id: queuedId, title: '未开始任务', status: 'queued', position: 3 });

const delivery = (task: Task): Delivery => ({
  id: randomUUID(), taskId: task.id, attemptId: randomUUID(), version: 1, summary: '已验证的交付',
  done: ['完成改动'], notCovered: [], verification: ['检查通过'], howTo: [], issues: [],
  commit: approvedCommit, review: 'accepted', feedback: null, reviewedAt: 10, createdAt: 10,
});

const detail = (task: Task) => ({
  task, decisions: [], progress: [], questions: [], events: [], attempts: [],
  deliveries: task.status === 'review' ? [delivery(task)] : [],
});

function project(settings: ProjectGitSettings): WebProject {
  return {
    id: projectId, name: projectName, lastMachineId: null, createdAt: 1, gitSettings: settings,
    counts: { unscheduled: 0, queued: 1, running: 0, review: 2, done: 0, interrupted: 0, cancelled: 0 },
  };
}

async function mockPlatform(page: import('@playwright/test').Page) {
  const state = {
    settings: { baseBranch: null, syncBeforeStart: true, version: 1 } as ProjectGitSettings,
    tasks: new Map<string, Task>([[awaitingId, awaitingTask], [blockedId, blockedTask], [queuedId, queuedTask]]),
    patchBody: undefined as unknown, createBody: undefined as unknown, retryCalls: 0, conflictNext: false,
  };
  await page.route('**/api/v1/web/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice('/api/v1/web'.length);
    const method = request.method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/auth/me') return json({ authenticated: true });
    if (path === '/projects' && method === 'GET') return json({ projects: [project(state.settings)] });
    if (path === '/machines' && method === 'GET') return json({ machines: [] });
    if (path === `/projects/${projectId}/tasks` && method === 'GET') return json({ tasks: [...state.tasks.values()] });
    if (path === `/projects/${projectId}/git` && method === 'PATCH') {
      const body = request.postDataJSON() as ProjectGitSettings;
      state.patchBody = body;
      if (state.conflictNext || body.version !== state.settings.version) {
        state.conflictNext = false;
        return json({ error: { code: 'conflict', message: 'stale settings' } }, 409);
      }
      state.settings = { ...body, version: state.settings.version + 1 };
      return json({ settings: state.settings });
    }
    if (path === '/tasks' && method === 'POST') {
      const body = request.postDataJSON() as { title: string; baseBranch?: string | null };
      state.createBody = body;
      const task = makeTask({ id: randomUUID(), title: body.title, baseBranch: body.baseBranch ?? null });
      state.tasks.set(task.id, task);
      return json({ task }, 201);
    }
    const retry = path.match(/^\/tasks\/([^/]+)\/retry-git$/);
    if (retry && method === 'POST') {
      state.retryCalls += 1;
      const task = state.tasks.get(decodeURIComponent(retry[1]!));
      if (!task?.git) return json({ error: { code: 'not_found', message: 'missing' } }, 404);
      const updated = { ...task, git: { ...task.git, phase: 'cleanup_pending' as const, message: null } };
      state.tasks.set(updated.id, updated);
      return json({ task: updated });
    }
    const taskDetail = path.match(/^\/tasks\/([^/]+)$/);
    if (taskDetail && method === 'GET') {
      const task = state.tasks.get(decodeURIComponent(taskDetail[1]!));
      return task ? json(detail(task)) : json({ error: { code: 'not_found', message: 'missing' } }, 404);
    }
    return json({ error: { code: 'not_found', message: `unmocked ${method} ${path}` } }, 404);
  });
  return state;
}

let server: Server;
let origin: string;
test.beforeAll(async () => { ({ server, origin } = await startStaticServer()); });
test.afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test('项目 Git 设置保存、任务继承与开始后锁定', async ({ page }) => {
  const state = await mockPlatform(page);
  await page.goto(`${origin}/projects/${projectId}`);
  await expect(page.getByText(/此项目尚未设置默认基准分支/)).toBeVisible();
  await page.getByRole('button', { name: '设置基准分支', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('基准分支')).toBeFocused();
  await dialog.getByLabel('基准分支').fill('main');
  await dialog.getByLabel('开工前同步上游').click();
  await expect(dialog.getByLabel('开工前同步上游')).not.toBeChecked();
  const patch = page.waitForRequest((request) => request.url().endsWith(`/api/v1/web/projects/${projectId}/git`));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect((await patch).postDataJSON()).toEqual({ baseBranch: 'main', syncBeforeStart: false, version: 1 });
  expect(state.patchBody).toEqual({ baseBranch: 'main', syncBeforeStart: false, version: 1 });
  await expect(dialog).toBeHidden();
  await expect(page.locator('.project-git-summary')).toContainText('main');
  await expect(page.locator('.project-git-summary')).toContainText('开工前不同步');
  await expect(page.getByText(/此项目尚未设置默认基准分支/)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Git 设置', exact: true })).toBeFocused();

  // 基准分支非法时不发请求，只提示输入错误。
  await page.getByRole('button', { name: 'Git 设置', exact: true }).click();
  const conflictDialog = page.getByRole('dialog');
  await conflictDialog.getByLabel('基准分支').fill('-bad');
  await conflictDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(conflictDialog.getByText('请输入合法的 Git 分支名。')).toBeVisible();
  expect(state.patchBody).toMatchObject({ baseBranch: 'main' });
  // 版本冲突时保留输入、提示冲突，并解除忙碌状态。
  await conflictDialog.getByLabel('基准分支').fill('next');
  state.conflictNext = true;
  await conflictDialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(conflictDialog.getByRole('alert')).toContainText('项目 Git 设置已更新');
  await expect(conflictDialog.getByLabel('基准分支')).toHaveValue('next');
  await expect(conflictDialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  await conflictDialog.getByRole('button', { name: '返回', exact: true }).click();
  await expect(conflictDialog).toBeHidden();

  await page.goto(`${origin}/tasks/${queuedId}`);
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  const branchInput = page.getByRole('dialog').getByLabel('任务基准分支');
  await expect(branchInput).toBeEnabled();
  await expect(branchInput).toHaveValue('');
  await expect(branchInput).toHaveAttribute('placeholder', '继承项目默认（main）');
  await page.getByRole('dialog').getByRole('button', { name: '返回', exact: true }).click();

  await page.goto(`${origin}/projects/${projectId}`);
  await page.getByRole('button', { name: '新建任务', exact: true }).filter({ visible: true }).click();
  const createDialog = page.getByRole('dialog');
  await createDialog.getByLabel('任务标题').fill('使用覆盖分支');
  await createDialog.getByLabel('任务基准分支').fill('feature/ui');
  const created = page.waitForRequest((request) => request.url().endsWith('/api/v1/web/tasks') && request.method() === 'POST');
  await createDialog.getByRole('button', { name: '创建任务', exact: true }).click();
  expect((await created).postDataJSON()).toMatchObject({ baseBranch: 'feature/ui', projectId });
  expect(state.createBody).toMatchObject({ baseBranch: 'feature/ui' });
  await expect(page).toHaveURL(/\/tasks\/[0-9a-f-]+$/);

  await page.goto(`${origin}/tasks/${awaitingId}`);
  await page.getByRole('button', { name: '编辑任务', exact: true }).click();
  const lockedInput = page.getByRole('dialog').getByLabel('任务基准分支');
  await expect(lockedInput).toBeDisabled();
  await expect(lockedInput).toHaveValue('main');
  await expect(page.getByRole('dialog')).toContainText('任务已开始，基准分支已锁定。');
});

test('集成阶段状态、重试门禁、手机布局与焦点', async ({ page }) => {
  const state = await mockPlatform(page);
  await page.goto(`${origin}/projects/${projectId}`);
  await expect(page.getByRole('heading', { name: /待验收与集成/ })).toBeVisible();
  const awaitingRow = page.getByRole('link', { name: /等待合并任务/ });
  await expect(awaitingRow).toContainText('等待合并');
  await expect(awaitingRow).toContainText('main → feature/await');
  expect(await awaitingRow.innerText()).not.toContain('待验收');
  await expect(page.getByRole('link', { name: /清理受阻任务/ })).toContainText('清理受阻');

  await awaitingRow.click();
  await expect(page.locator('.detail-head')).toContainText('等待合并');
  await expect(page.getByRole('heading', { name: 'Git 集成' })).toBeVisible();
  await expect(page.locator('.git-section')).toContainText(baseCommit);
  await expect(page.locator('.git-section')).toContainText(approvedCommit);
  await expect(page.getByRole('button', { name: /验收通过|返修/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消任务', exact: true })).toBeDisabled();
  await expect(page.getByText('集成操作进行中，完成前不能取消或恢复任务。')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('heading', { name: 'Git 集成' })).toBeVisible();

  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto(`${origin}/tasks/${blockedId}`);
  await expect(page.locator('.detail-head')).toContainText('清理受阻');
  await expect(page.locator('.git-section')).toContainText(mergedCommit);
  const retry = page.getByRole('button', { name: '重试清理', exact: true });
  await expect(page.getByText('合并已完成，仅重新尝试清理任务工作树和分支。')).toBeVisible();
  const retried = page.waitForRequest((request) => request.url().endsWith(`/api/v1/web/tasks/${blockedId}/retry-git`));
  await retry.click();
  expect((await retried).postDataJSON()).toEqual({});
  expect(state.retryCalls).toBe(1);
  await expect(page.locator('.detail-head')).toContainText('清理中');
  await expect(retry).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Git 集成' })).toBeFocused();
});

test('弹窗打开后远端设置更新时仍按冻结版本保存并保留草稿', async ({ page }) => {
  const state = await mockPlatform(page);
  await page.goto(`${origin}/projects/${projectId}`);
  await page.getByRole('button', { name: '设置基准分支', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('基准分支').fill('main');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.project-git-summary')).toContainText('main');

  // 打开弹窗并修改草稿后，其他会话把设置改成 release（版本 3）。
  await page.getByRole('button', { name: 'Git 设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('基准分支').fill('next');
  state.settings = { baseBranch: 'release', syncBeforeStart: true, version: 3 };
  // 复用既有可见性恢复刷新，触发轮询拉取新版本，不依赖固定等待。
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.project-git-summary')).toContainText('release');

  const patch = page.waitForRequest((request) => request.url().endsWith(`/api/v1/web/projects/${projectId}/git`));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  // 保存仍发送打开弹窗时冻结的版本 2，而不是轮询到的版本 3。
  expect((await patch).postDataJSON()).toEqual({ baseBranch: 'next', syncBeforeStart: true, version: 2 });
  await expect(dialog.getByRole('alert')).toContainText('项目 Git 设置已更新');
  // 冲突后保留草稿，不盲目升级版本重试；远端设置保持不变。
  await expect(dialog.getByLabel('基准分支')).toHaveValue('next');
  await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled();
  expect(state.settings).toEqual({ baseBranch: 'release', syncBeforeStart: true, version: 3 });
  await expect(page.locator('.project-git-summary')).toContainText('release');
  await dialog.getByRole('button', { name: '返回', exact: true }).click();
  await expect(dialog).toBeHidden();
  // 关闭重开后才拿到最新版本，再保存成功。
  await page.getByRole('button', { name: 'Git 设置', exact: true }).click();
  dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('基准分支')).toHaveValue('release');
  await dialog.getByLabel('基准分支').fill('next');
  const reopened = page.waitForRequest((request) => request.url().endsWith(`/api/v1/web/projects/${projectId}/git`));
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  expect((await reopened).postDataJSON()).toEqual({ baseBranch: 'next', syncBeforeStart: true, version: 3 });
  await expect(dialog).toBeHidden();
  await expect(page.locator('.project-git-summary')).toContainText('next');
});
