import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['--test', 'packages/host/test/profile-routing.test.mjs'], { encoding: 'utf8', env: process.env });
process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
if (result.status !== 0) process.exit(result.status ?? 1);
console.log('m1b-profile-e2e: PASS (public member request and isolated execution routing)');
