import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { HEARTBEAT_INTERVAL_MS, MACHINE_ONLINE_WINDOW_MS } from '@pi-steward/contract';
import { configPath, readConfig } from './config.js';
import { Launcher } from './launcher.js';
import { platformClient } from './platform.js';
import { initConfig, launchService } from './service.js';
import { acquireRunLock, loadState, saveState } from './state.js';
import { tmuxClient } from './tmux.js';

const home = homedir();
const configFile = configPath();
const stateFile = join(home, 'Library', 'Application Support', 'pi-steward', 'launcher-state.json');

async function run() {
  const config = readConfig(configFile);
  const release = acquireRunLock(stateFile);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const extensionPath = fileURLToPath(new URL('../../../packages/pi-extension/dist/index.js', import.meta.url));
    const origin = new URL(config.platformUrl).origin;
    const platform = platformClient(config, fetch, () => {
      const current = readConfig(configFile);
      // 运行中的平台地址固定，配置改指另一台平台时不能把新令牌发往旧地址。
      if (new URL(current.platformUrl).origin !== origin) throw new Error('platform_origin_changed');
      return current.machineToken;
    });
    const launcher = new Launcher({ config, version, state: loadState(stateFile), save: (state) => saveState(stateFile, state),
      platform, tmux: tmuxClient(config, { configPath: configFile, extensionPath }),
      warn: (text) => console.error(text),
    });
    while (!stop.signal.aborted) {
      const start = performance.now();
      await launcher.tick();
      if (stop.signal.aborted) break;
      await sleep(Math.max(0, HEARTBEAT_INTERVAL_MS - (performance.now() - start)), undefined, { signal: stop.signal }).catch((error) => {
        if (!stop.signal.aborted) throw error;
      });
    }
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    release();
  }
}

async function main(command?: string) {
  const service = launchService({ home, uid: process.getuid?.() ?? -1, node: process.execPath,
    launcher: fileURLToPath(import.meta.url), config: configFile });
  switch (command) {
    case 'run': return run();
    case 'init': initConfig(configFile); console.log(`配置模板已写入 ${configFile}，请填写平台地址、机器令牌和项目。`); return;
    case 'install': readConfig(configFile); return service.install();
    case 'uninstall': return service.uninstall();
    case 'status': {
      const config = readConfig(configFile);
      const state = loadState(stateFile);
      const online = state.lastHeartbeatAt !== undefined && Date.now() - state.lastHeartbeatAt < MACHINE_ONLINE_WINDOW_MS;
      const extensionPath = fileURLToPath(new URL('../../../packages/pi-extension/dist/index.js', import.meta.url));
      const tmux = tmuxClient(config, { configPath: configFile, extensionPath });
      console.log(`${new URL(config.platformUrl).origin} | ${online ? '在线' : '离线'} | ${config.projects.length} 个项目 | ${config.slots} 个名额`);
      for (const { target, phase } of state.executions) {
        const status = phase === 'exited' ? '待上报退出' : { present: '运行中', absent: '未运行', unavailable: '无法核对' }[await tmux.inspect(target)];
        console.log(`${target} | ${status}`);
      }
      return;
    }
    default: console.error('用法：launcher <run|init|install|uninstall|status>'); process.exitCode = 1;
  }
}

main(process.argv[2]).catch((error: NodeJS.ErrnoException) => {
  // 系统错误、子进程错误和配置内容都不直接打印到服务日志。
  console.error(error.code === 'EEXIST' ? '目标文件已存在。' : error.code ? '启动器操作失败，请检查本地目录权限和配置。' : error.message);
  process.exitCode = 1;
});
