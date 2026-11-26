import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ExtensionAPI, ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';
import { registerSteward } from '../src/index.js';
it.each([
  { metadata: {}, code: 'git_commit_required' },
  { metadata: { commit: 'abcdef' }, code: 'git_commit_required' },
  { metadata: { commit: 'a'.repeat(40), baseCommit: 'bad' }, code: 'git_base_commit_invalid' },
  { metadata: { commit: 'a'.repeat(40) }, code: 'workspace_unavailable' },
])('delivery after reload reads fresh context and enforces $code before POST', async ({ metadata, code }) => {
  const dir = mkdtempSync(join(tmpdir(), 'steward-delivery-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ platformUrl: 'https://example.invalid', machineToken: `stm_${randomBytes(32).toString('base64url')}`,
      slots: 1, projects: [], path: ['/usr/bin'], pi: { command: 'pi', extraArgs: [] } }), { mode: 0o600 });
    const snapshot = { baseBranch: 'main', baseCommit: 'a'.repeat(40), taskBranch: 'feature/task', repositoryPath: dir, worktreePath: null,
      machineId: randomUUID(), syncBeforeStart: false, syncResult: 'disabled', phase: 'prepared', operationId: null, deliveryId: null,
      approvedCommit: null, mergedCommit: null, message: null };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      task: { id: randomUUID(), projectId: 'p', title: 't', goal: '', acceptance: '', notes: '', type: 'implementation' },
      attempt: { id: randomUUID(), kind: 'new' }, workspace: { path: dir, requirements: [] }, decisions: [], deliveries: [], questions: [], git: snapshot,
    }));
    const registerTool = vi.fn<ExtensionAPI['registerTool']>();
    registerSteward({ registerTool, on: vi.fn() } as unknown as ExtensionAPI,
      { env: { STEWARD_ATTEMPT_ID: randomUUID(), STEWARD_CONFIG: config }, fetcher });
    const tool = registerTool.mock.calls.map(([tool]) => tool).find((tool) => tool.name === 'steward_deliver')!;
    const result = await tool.execute('call', { summary: 't', done: [], notCovered: [], verification: [], howTo: [], issues: [], ...metadata }, undefined,
      undefined, { cwd: dir, sessionManager: { getSessionId: () => randomUUID(), getSessionFile: () => undefined } } as unknown as ExtensionToolContext);
    expect(result.details).toEqual({ code });
    if (code === 'git_commit_required') expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('git rev-parse HEAD') })]));
    expect(fetcher.mock.calls).toHaveLength(1); expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
