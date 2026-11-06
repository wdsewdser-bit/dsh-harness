import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { canonical } from '../contracts/index.mjs';
import { spawnSync } from 'node:child_process';
const [directory, encoded] = process.argv.slice(2);
const request = JSON.parse(encoded);
const git = (...args) => {
  const r = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stdout.trim();
};
if (git('status', '--porcelain')) throw Error('DIRTY_WORKTREE');
if (git('rev-parse', 'HEAD') !== request.candidate || git('rev-parse', 'HEAD^{tree}') !== request.tree) throw Error('SHA_MISMATCH');
const changed = git('diff', '--name-only', request.base, request.candidate).split(String.fromCharCode(10)).filter(Boolean);
if (!request.allowedPaths.length || request.allowedPaths.some(p => p === '..' || p.startsWith('../')) ||
  changed.some(file => !request.allowedPaths.some(p => p === '' || file === p || file.startsWith(p + '/')))) throw Error('OUT_OF_SCOPE_DIFF');
const files = git('ls-tree', '-r', '--name-only', request.candidate).split(String.fromCharCode(10));
const blobs = files.filter(Boolean).map(file => {
  const readback = spawnSync('git', ['-C', directory, 'show', request.candidate + ':' + file]);
  if (readback.status !== 0) throw Error('BLOB_READ_FAILED');
  return { file, sha256: createHash('sha256').update(readback.stdout).digest('hex') };
});
const certificate = { ...request, blobs, diff: git('diff', '--stat', request.base, request.candidate), independentProcess: true };
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const signature = sign(null, Buffer.from(canonical(certificate)), privateKey).toString('base64');
console.log(JSON.stringify({ certificate, signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }));
