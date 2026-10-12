#!/usr/bin/env node
/** Headless Agent Team run for the Minecraft-web task, with a durable transcript. */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const bin = 'D:\\dsh-test\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js';
const home = 'D:\\dsh-test\\home';
const workdir = 'D:\\dsh-test\\workspace\\mc-web';
const logFile = 'D:\\dsh-test\\workspace\\mc-run.log';
const taskText = fs.readFileSync('D:\\dsh-test\\workspace\\mc-task.txt', 'utf8');

fs.mkdirSync(workdir, { recursive: true });
const out = fs.openSync(logFile, 'a');
fs.writeSync(out, '\n=== run @ ' + new Date().toISOString() + ' ===\n');

const child = spawn(process.execPath, [bin, '--profile', 'teamtest', taskText], {
  cwd: workdir,
  env: { ...process.env, DSH_HOME: home },
  stdio: ['ignore', out, out],
});
console.log('pid=' + child.pid + ' log=' + logFile);
child.on('exit', (code) => { console.log('exit=' + code); process.exit(0); });
