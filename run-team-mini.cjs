#!/usr/bin/env node
/** Headless Agent Team run for one tiny task, used to verify the domain fork. */
const fs = require('fs');
const { spawn } = require('child_process');

const bin = 'D:\\dsh-test\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const home = 'D:\\dsh-test\\home';
const workdir = 'D:\\dsh-test\\workspace\\mini';
const logFile = 'D:\\dsh-test\\workspace\\mini-run.log';
const taskText = fs.readFileSync('D:\\dsh-test\\workspace\\mini-task.txt', 'utf8');

fs.mkdirSync(workdir, { recursive: true });
fs.writeFileSync(logFile, '');
const out = fs.openSync(logFile, 'a');

const child = spawn(process.execPath, [bin, '--profile', 'teamtest', taskText], {
  cwd: workdir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', out, out],
});
const timer = setTimeout(() => { try { child.kill(); } catch {} }, 240000);
console.log('pid=' + child.pid + ' log=' + logFile);
child.on('exit', (code) => { clearTimeout(timer); console.log('exit=' + code); process.exit(0); });
