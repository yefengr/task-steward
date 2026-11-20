import { open, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { backup } from 'node:sqlite';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { addMachine, hashPassword, newMachineToken, revokeMachine } from './auth.js';
import { databasePath } from './config.js';
import { openStore } from './store.js';
import type { Store } from './store.js';

async function readSecret(prompt: string) {
  if (process.stdin.isTTY) {
    const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const terminal = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
    process.stderr.write(prompt);
    try { return await terminal.question(''); }
    finally { terminal.close(); process.stderr.write('\n'); }
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 4096) throw new Error('Secret input is too long');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function backupDatabase(store: Store, path: string) {
  const target = await open(path, 'wx', 0o600);
  await target.close();
  try { await backup(store.connection, path); }
  catch (error) { await unlink(path); throw error; }
}

async function run(args: string[]) {
  const [command, arg] = args;
  if (command === 'hash-password' && args.length === 1) {
    console.log(await hashPassword(await readSecret('Access password: ')));
    return;
  }
  if (!arg || args.length !== 2 || !['machine:add', 'machine:revoke', 'backup'].includes(command ?? '')) {
    console.error('Usage: admin.js hash-password | machine:add <name> | machine:revoke <name> | backup <path>');
    process.exitCode = 1;
    return;
  }
  const store = openStore(databasePath());
  try {
    if (command === 'machine:add') {
      const generate = process.stdin.isTTY && process.stdout.isTTY;
      const token = generate ? newMachineToken() : await readSecret('Machine token: ');
      const id = addMachine(store, arg, token, Date.now());
      console.log(`Machine registered: ${id}`);
      if (generate) console.log(token);
    } else if (command === 'machine:revoke') {
      if (!revokeMachine(store, arg, Date.now())) throw new Error('Machine not found');
      console.log('Machine revoked');
    } else {
      await backupDatabase(store, arg);
      console.log('Database snapshot saved');
    }
  } finally { store.connection.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await run(process.argv.slice(2)); }
  catch { console.error('Admin operation failed. Check inputs, permissions and database state.'); process.exitCode = 1; }
}
