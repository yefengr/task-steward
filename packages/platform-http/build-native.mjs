import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform === 'darwin') {
  const source = fileURLToPath(new URL('./native/steward-http.swift', import.meta.url));
  const dist = fileURLToPath(new URL('./dist', import.meta.url));
  mkdirSync(dist, { recursive: true });
  const staging = mkdtempSync(join(dist, 'native-'));
  const run = (program, args) => execFileSync(program, args, { stdio: 'inherit' });
  try {
    const slices = ['arm64', 'x86_64'].map((arch) => {
      const binary = join(staging, arch);
      run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target',
        `${arch}-apple-macos13.5`, source, '-o', binary]);
      return binary;
    });
    const binary = join(staging, 'steward-http');
    run('/usr/bin/xcrun', ['lipo', '-create', ...slices, '-output', binary]);
    run('/usr/bin/codesign', ['--force', '--sign', '-', binary]);
    renameSync(binary, join(dist, 'steward-http'));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
