import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.platform !== 'darwin') throw new Error('Steward npm packages must be built on macOS');

const root = fileURLToPath(new URL('..', import.meta.url));
const requireFromWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = await import(pathToFileURL(requireFromWeb.resolve('vite')).href);
const launcher = requireFromWeb('../../apps/launcher/package.json');
const requireFromLauncher = createRequire(new URL('../apps/launcher/package.json', import.meta.url));
const staging = mkdtempSync(join(tmpdir(), 'stew-package-'));
const target = resolve(process.argv[2] ?? '.pi/tmp');

async function bundle(entry, name, shebang) {
  await build({
    root, configFile: false, envDir: false, publicDir: false, logLevel: 'warn',
    build: {
      outDir: join(staging, 'dist'), emptyOutDir: false, minify: false, target: 'node24',
      ssr: join(root, entry),
      rolldownOptions: {
        external: (id) => isBuiltin(id) || /^(zod|typebox)(\/|$)/u.test(id),
        output: { entryFileNames: name, ...(shebang ? { banner: '#!/usr/bin/env node' } : {}) },
      },
    },
    ssr: { noExternal: ['@pi-steward/contract', '@pi-steward/platform-http', '@pi-steward/execution-runtime'] },
  });
}

try {
  await bundle('apps/launcher/dist/index.js', 'index.js', true);
  await bundle('packages/pi-extension/dist/index.js', 'extension.js', false);
  copyFileSync(join(root, 'packages/platform-http/dist/steward-http'), join(staging, 'dist/steward-http'));
  writeFileSync(join(staging, 'package.json'), `${JSON.stringify({
    name: '@yefengr/steward', version: launcher.version, description: 'Task Steward macOS launcher and task extension',
    repository: { type: 'git', url: 'git+https://github.com/yefengr/task-steward.git' },
    type: 'module', bin: { stew: './dist/index.js' }, engines: { node: '>=24.20.0 <25' }, os: ['darwin'],
    files: ['dist'], keywords: ['pi-package', 'pi-extension', 'task-steward'],
    pi: { extensions: ['./dist/extension.js'] },
    dependencies: { zod: requireFromLauncher('zod/package.json').version },
    peerDependencies: { typebox: '*' },
    peerDependenciesMeta: { typebox: { optional: true } },
  }, null, 2)}\n`);
  mkdirSync(target, { recursive: true });
  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', target], { cwd: staging, stdio: 'inherit' });
} finally { rmSync(staging, { recursive: true, force: true }); }
