import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const LABEL = 'dev.pi-steward.launcher';
const DEFAULT_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const exec = promisify(execFile);

function binaryDir(name: string, path: string[]) {
  return path.find((folder) => {
    try { accessSync(join(folder, name), constants.X_OK); return true; } catch { return false; }
  });
}

export function initConfig(path: string, env = process.env) {
  const current = (env.PATH ?? '').split(delimiter).filter(isAbsolute);
  const executableDirs = ['pi', 'node', 'tmux'].map((name) => binaryDir(name, current)).filter((dir) => dir !== undefined);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({
    platformUrl: 'https://steward.example.com', machineToken: '请填入机器令牌', slots: 1,
    projects: [], pi: { command: 'pi', extraArgs: [] },
    path: [...new Set([...executableDirs, dirname(process.execPath), ...DEFAULT_PATH])],
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

const xml = (value: string) => value.replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]!);

export function launchService(options: {
  home: string; uid: number; node: string; launcher: string; config: string;
  launchctl?: (args: string[]) => Promise<unknown>;
}) {
  const plist = join(options.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const logs = join(options.home, 'Library', 'Logs', 'pi-steward');
  const domain = `gui/${options.uid}`;
  const run = options.launchctl ?? ((args) => exec('/bin/launchctl', args, { timeout: 10_000 }));
  return {
    async install() {
      mkdirSync(dirname(plist), { recursive: true, mode: 0o700 });
      mkdirSync(logs, { recursive: true, mode: 0o700 });
      writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(options.node)}</string><string>${xml(options.launcher)}</string><string>run</string></array>
<key>EnvironmentVariables</key><dict><key>STEWARD_CONFIG</key><string>${xml(options.config)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${xml(join(logs, 'launcher.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logs, 'launcher-error.log'))}</string>
</dict></plist>
`, { mode: 0o600, flag: 'wx' });
      try { await run(['bootstrap', domain, plist]); } catch {
        rmSync(plist, { force: true });
        throw new Error('launchctl bootstrap 失败，请在 Mac 登录会话中检查服务状态。');
      }
    },
    async uninstall() {
      try { await run(['bootout', `${domain}/${LABEL}`]); } catch {
        throw new Error(`launchctl bootout 失败，已保留 plist：${JSON.stringify(plist)}。在当前 Mac 登录会话用 launchctl print ${domain}/${LABEL} 核对。若服务仍加载，修复原因后重试卸载。若已确认卸载，可按需备份并手动移走该 plist，再重新安装。`);
      }
      rmSync(plist, { force: true });
    },
  };
}
