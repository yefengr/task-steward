import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_STEWARD_ORIGIN, HEARTBEAT_INTERVAL_MS, MACHINE_ONLINE_WINDOW_MS, localConfigSchema, platformProxySchema } from '@pi-steward/contract';
import { configPath, readConfig } from './config.js';
import { runExtensionCommand } from './extension-registration.js';
import { Launcher } from './launcher.js';
import { pairMachine } from './pairing.js';
import { platformClient } from './platform.js';
import { addProject } from './projects.js';
import { checkPiPrerequisite, initConfig, launchService } from './service.js';
import { acquireRunLock, loadState, saveState } from './state.js';
import { tmuxClient, tmuxHealthText } from './tmux.js';

const home = homedir();
const configFile = configPath();
const stateFile = join(home, 'Library', 'Application Support', 'pi-steward', 'launcher-state.json');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const packagedExtension = fileURLToPath(new URL('./extension.js', import.meta.url));
const extensionPath = existsSync(packagedExtension) ? packagedExtension :
  fileURLToPath(new URL('../../../packages/pi-extension/dist/index.js', import.meta.url));

async function run() {
  const config = readConfig(configFile);
  const release = acquireRunLock(stateFile);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  try {
    const origin = new URL(config.platformUrl).origin;
    const platform = platformClient(config);
    const launcher = new Launcher({ config, version, state: loadState(stateFile), save: (state) => saveState(stateFile, state),
      platform, tmux: tmuxClient(config, { configPath: configFile, extensionPath }), configFile,
      warn: (text) => console.error(text),
    });
    while (!stop.signal.aborted) {
      const start = performance.now();
      try {
        const current = readConfig(configFile);
        // 同一轮只使用一个配置快照，项目列表与令牌不会来自不同版本。
        if (new URL(current.platformUrl).origin !== origin) throw new Error('platform_origin_changed');
        config.machineToken = current.machineToken;
        config.projects = current.projects;
        config.proxy = current.proxy;
      } catch {
        console.error('无法重新读取当前平台配置，将在下次心跳重试。');
        await sleep(HEARTBEAT_INTERVAL_MS, undefined, { signal: stop.signal }).catch(() => undefined);
        continue;
      }
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

async function pair(args: string[]) {
  const { values } = parseArgs({ args, options: { url: { type: 'string' }, proxy: { type: 'string' },
    'allow-http-loopback': { type: 'boolean' } } });
  const proxy = values.proxy === undefined ? undefined : platformProxySchema.safeParse(
    values.proxy === 'system' || values.proxy === 'direct' ? { mode: values.proxy } : { mode: 'custom', url: values.proxy },
  );
  if (proxy?.success === false) throw new Error('代理必须为 system、direct 或不含凭据的 http://主机:端口。');
  const saved = readConfig(configFile, true) ?? readConfig(`${configFile}.pairing`, true);
  const allowHttpLoopback = values['allow-http-loopback'] || saved?.allowHttpLoopback ? true : undefined;
  const platformUrl = values.url ?? saved?.platformUrl ?? DEFAULT_STEWARD_ORIGIN;
  if (!localConfigSchema.shape.platformUrl.safeParse(platformUrl).success) throw new Error('Steward 地址无效。');
  const url = new URL(platformUrl);
  const loopback = ['127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    !(url.protocol === 'https:' || (allowHttpLoopback && loopback && url.protocol === 'http:'))) {
    throw new Error('请输入不带路径的 HTTPS 平台地址。');
  }
  const release = acquireRunLock(`${configFile}.write`, '已有 Steward 命令正在更新配置，请稍后重试。');
  try {
    const name = hostname().replace(/[\p{Cc}]/gu, '').trim().slice(0, 128) || 'Mac';
    await pairMachine({ path: configFile, name, origin: url.origin, allowHttpLoopback, proxy: proxy?.data,
      display: (code) => console.log(`配对码 ${code}`),
    });
    console.log('此电脑已配对。运行 stew start 启动后台服务。');
  } finally { release(); }
}

async function main(command?: string, ...args: string[]) {
  const service = launchService({ home, uid: process.getuid?.() ?? -1, node: process.execPath,
    launcher: fileURLToPath(import.meta.url), config: configFile });
  switch (command) {
    case 'pair': return pair(args);
    case 'start':
    case 'install': {
      if (process.platform !== 'darwin') throw new Error('Steward 后台服务需要 macOS。');
      const config = readConfig(configFile);
      const tmux = tmuxClient(config, { configPath: configFile, extensionPath });
      const health = await tmux.check({ verifyVersion: true });
      if (health !== 'ready') throw new Error(`${tmuxHealthText[health]}。`);
      checkPiPrerequisite(config.path, config.pi.command);
      if (!existsSync(extensionPath)) throw new Error('找不到随包安装的 Steward Pi 扩展。');
      await service.install();
      if (command === 'start') console.log('后台服务已启动。进入项目目录运行 stew add，稍后可在网页查看电脑是否在线。');
      return;
    }
    case 'add': {
      const { project, added } = addProject(configFile);
      console.log(`${added ? '已登记' : '已登记过'}项目「${project.name}」。后台服务运行时，项目会在下一次心跳同步。`);
      return;
    }
    case 'extension': {
      const config = readConfig(configFile, true);
      console.log(await runExtensionCommand(args, { moduleUrl: import.meta.url, config }));
      return;
    }
    case undefined: {
      const config = readConfig(configFile, true);
      if (!config) console.log('尚未配对。运行 stew pair 接入这台电脑。');
      else if (!await service.isLoaded()) console.log('此电脑已配对。运行 stew start 启动后台服务。');
      else if (!config.projects.length) console.log('后台服务已加载。进入项目目录运行 stew add。');
      else console.log(`后台服务已加载，已登记 ${config.projects.length} 个项目。运行 stew status 查看本机状态。`);
      return;
    }
    case '--version': console.log(version); return;
    case 'run': return run();
    case 'init': initConfig(configFile); console.log(`配置模板已写入 ${configFile}，请填写平台地址、机器令牌和项目。`); return;
    case 'uninstall': return service.uninstall();
    case 'status': {
      const config = readConfig(configFile);
      const state = loadState(stateFile);
      const online = state.lastHeartbeatAt !== undefined && Date.now() - state.lastHeartbeatAt < MACHINE_ONLINE_WINDOW_MS;
      const tmux = tmuxClient(config, { configPath: configFile, extensionPath });
      const health = await tmux.check();
      console.log(`${new URL(config.platformUrl).origin} | ${online ? '在线' : '离线'} | ${config.projects.length} 个项目 | ${config.slots} 个配置名额`);
      console.log(health === 'ready' ? tmuxHealthText[health] : `${tmuxHealthText[health]}。暂停领取新任务。`);
      for (const { target, phase } of state.executions) {
        const status = phase === 'exited' ? '待上报退出' : { present: '运行中', absent: '未运行', unavailable: '无法核对' }[await tmux.inspect(target)];
        console.log(`${target} | ${status}`);
      }
      return;
    }
    case '--help': console.log('用法：stew [pair|start|add|status|extension]\n指定任务平台：stew pair --url https://你的域名\n代理：stew pair --proxy system|direct|http://主机:端口（默认 system）\nPi 扩展：stew extension path|install|remove'); return;
    default: console.error('用法：stew [pair|start|add|status|extension]'); process.exitCode = 1;
  }
}

main(process.argv[2], ...process.argv.slice(3)).catch((error: NodeJS.ErrnoException) => {
  // 系统错误、子进程错误和配置内容都不直接打印到服务日志。
  console.error(error.code === 'EEXIST' ? '目标文件已存在。' : error.code ? '启动器操作失败，请检查本地目录权限和配置。' : error.message);
  process.exitCode = 1;
});
