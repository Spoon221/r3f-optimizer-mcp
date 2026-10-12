import { chmodSync, existsSync } from 'node:fs';

for (const file of ['dist/index.js', 'dist/cli.js']) {
  if (existsSync(file)) chmodSync(file, 0o755);
}
