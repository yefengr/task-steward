import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export function databasePath(env: NodeJS.ProcessEnv = process.env) {
  const directory = env.STEWARD_DATA_DIR ?? './data';
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, 'steward.sqlite');
}
