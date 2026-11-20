import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.js';
import { pairMachine } from '../src/pairing.js';
import { addProject } from '../src/projects.js';

const directories: string[] = [];
function makeDirectory() {
  const dir = mkdtempSync(join(tmpdir(), 'stew-pair-'));
  directories.push(dir);
  return dir;
}
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('网页确认前保留私有待确认凭据，断线后继续配对并重复登记同一 Git 项目', async () => {
  const dir = makeDirectory();
  const path = join(dir, 'config.json');
  const origin = 'https://example.test';
  let status = 'expired';
  const request = vi.fn<typeof fetch>(async (input, init) => {
    expect(init?.redirect).toBe('error');
    const body = JSON.parse(String(init?.body));
    const pending = readConfig(`${path}.pairing`, true);
    if (String(input).endsWith('/create')) {
      expect(pending).toBeDefined();
      expect(body).toEqual({ name: expect.stringMatching(/^Fixture Mac · [a-f0-9]{8}$/u),
        tokenHash: createHash('sha256').update(pending!.machineToken).digest('hex') });
      status = 'pending';
      return Response.json({ code: 'A123B456C7', expiresAt: 10_000 });
    }
    const tokens = [pending?.machineToken, readConfig(path, true)?.machineToken].filter(Boolean);
    expect(tokens).toContain(body.machineToken);
    return Response.json({ status });
  });
  const display = vi.fn();
  const options = { path, origin, name: 'Fixture Mac', display, fetcher: request, elapsed: () => 0 };
  await expect(pairMachine({ ...options, wait: async () => { throw new Error('simulated interruption'); } }))
    .rejects.toThrow('simulated interruption');
  const pending = readConfig(`${path}.pairing`);
  expect(statSync(`${path}.pairing`).mode & 0o777).toBe(0o600);
  expect(readConfig(path, true)).toBeUndefined();
  expect(display).toHaveBeenCalledExactlyOnceWith('A123B456C7');
  status = 'approved';
  await pairMachine(options);
  expect(readConfig(path)).toEqual(pending);
  expect(readConfig(`${path}.pairing`, true)).toBeUndefined();
  const calls = request.mock.calls.length;
  await pairMachine(options);
  expect(request).toHaveBeenCalledTimes(calls + 1);

  const projectDir = join(dir, 'Example');
  const subdir = join(projectDir, 'src');
  mkdirSync(subdir, { recursive: true });
  execFileSync('git', ['init', '--quiet', projectDir]);
  const { project } = addProject(path, subdir);
  expect(project.name).toBe('Example');
  expect(addProject(path, projectDir)).toEqual({ project, added: false });
  expect(readConfig(path).projects).toEqual([project]);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(() => addProject(path, dir)).toThrow(/Git/u);

  const firstRegistration = readConfig(path);
  await pairMachine({ ...options, proxy: { mode: 'direct' } });
  expect(readConfig(path)).toEqual({ ...firstRegistration, proxy: { mode: 'direct' } });
  status = 'expired';
  await pairMachine({ ...options, wait: async () => { status = 'approved'; } });
  expect(readConfig(path)).toEqual({ ...firstRegistration, proxy: { mode: 'direct' },
    machineToken: expect.not.stringMatching(firstRegistration.machineToken) });
});
