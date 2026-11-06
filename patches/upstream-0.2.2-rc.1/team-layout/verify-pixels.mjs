import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import assert from 'node:assert/strict';
const scripts=fileURLToPath(new URL('./',import.meta.url)),web=JSON.parse(fs.readFileSync(scripts+'latest-web.json','utf8'));
const r=spawnSync(process.execPath,[scripts+'pngdiff.mjs',web.root+'/upstream/capture',web.root+'/patched/capture'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
const pixels=JSON.parse(r.stdout);fs.writeFileSync(scripts+'latest-pixels.json',JSON.stringify({root:web.root,pixels},null,2));
console.log('layout pixel differences:',pixels.map(p=>p.diffPixels).join('/'));
assert.equal(pixels.length,6);assert(pixels.every(p=>p.diffPixels===0),'pixel mismatch; measure a fresh native/native noise floor before accepting any tolerance');
console.log('PASS layout pixel parity: 6/6 exact, zero tolerance');
