import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const KEY = Symbol.for('pi-steward.extension-instance');
type Instance = { path: string; token: object };
const shared = globalThis as typeof globalThis & { [KEY]?: WeakMap<object, Instance> };
const instances = shared[KEY] ??= new WeakMap<object, Instance>();
const PROBE = 'pi-steward:instance-probe';

export function claimInstance(pi: ExtensionAPI, url: string) {
  const path = realpathSync(fileURLToPath(url));
  const existing = instances.get(pi.events);
  if (existing) {
    if (existing.path === path) return false;
    throw new Error(`Steward 扩展安装冲突：${existing.path} 与 ${path}；请只保留一个真实安装副本。`);
  }
  // event bus 也覆盖由独立模块上下文加载的副本。
  const probe = { path, conflict: false, duplicate: false };
  pi.events.emit(PROBE, probe);
  if (probe.conflict) throw new Error('Steward 扩展安装冲突：不同真实安装副本不能混用。');
  if (probe.duplicate) return false;
  const token = {};
  instances.set(pi.events, { path, token });
  const off = pi.events.on(PROBE, (data: unknown) => {
    const other = data as typeof probe;
    if (other.path === path) other.duplicate = true;
    else other.conflict = true;
  });
  pi.on('session_shutdown', () => {
    off();
    if (instances.get(pi.events)?.token === token) instances.delete(pi.events);
  });
  return true;
}
