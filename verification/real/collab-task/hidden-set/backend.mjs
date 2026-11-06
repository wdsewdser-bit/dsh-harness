import { spawn } from 'node:child_process';

// WHATWG Fetch's bad-port list. Windows may assign these to listen(0) (this host's dynamic range starts at 1024).
// Such an address is not an application failure: Fetch rejects it before sending any HTTP request.
const blocked = new Set([1,7,9,11,13,15,17,19,20,21,22,23,25,37,42,43,53,69,77,79,87,95,101,102,103,104,109,110,
  111,113,115,117,119,123,135,137,139,143,161,179,389,427,465,512,513,514,515,526,530,531,532,540,548,554,556,
  563,587,601,636,989,990,993,995,1719,1720,1723,2049,3659,4045,5060,5061,6000,6566,6665,6666,6667,6668,6669,6697,10080]);
export const fetchBlockedPort = url => {
  const address = new URL(url);
  return blocked.has(Number(address.port || (address.protocol === 'https:' ? 443 : 80)));
};

export async function stopBackend(started) {
  if (!started) return;
  const { child, closed } = started;
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) child.kill();
  await closed; // Reap the process AND its pipes before another server is started or the test returns.
}

async function launch(file, { spawnChild, timeoutMs }) {
  const child = spawnChild(process.execPath, [file], { env: { ...process.env, PORT: '0' }, stdio: ['ignore','pipe','pipe'] });
  const started = { child, closed: new Promise(resolve => child.once('close', resolve)) };
  let timer, output = '', diagnostic = '';
  const url = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('backend did not print a url within ' + timeoutMs + 'ms: ' + diagnostic)), timeoutMs);
    child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-2048); });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 65536) { reject(Error('backend startup output exceeds 64KiB')); return; }
      // A pipe data event is not a line boundary. Never use a truncated URL/port as the ready address.
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end).trim(); output = output.slice(end + 1);
        const address = line.split(/\s+/).find(value => /^https?:\/\//.test(value));
        if (address) { try { new URL(address); resolve(address); } catch (error) { reject(error); } }
      }
    });
    child.once('error', reject);
    child.once('exit', code => reject(Error('backend exited ' + code + ': ' + diagnostic)));
  });
  try { return { ...started, url: await url }; }
  catch (error) { await stopBackend(started); throw error; }
  finally { clearTimeout(timer); }
}

export async function startBackend(file, { spawnChild = spawn, timeoutMs = 10000, maxStarts = 16 } = {}) {
  const ports = [];
  for (let attempt = 0; attempt < maxStarts; attempt++) {
    const started = await launch(file, { spawnChild, timeoutMs });
    ports.push(new URL(started.url).port);
    if (!fetchBlockedPort(started.url)) return { ...started, startupPorts: ports };
    // Retry ONLY unusable environment addresses, before any discovery/API assertion. Never retry a failed application.
    await stopBackend(started);
  }
  throw Error('backend selected only Fetch-blocked ports: ' + ports.join(','));
}
