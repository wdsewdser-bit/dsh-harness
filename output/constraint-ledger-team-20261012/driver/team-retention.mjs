#!/usr/bin/env node
// 只读分析：核对每次压缩之后的普通对话请求，是否带着完整的约束清单块。
// 用法: node team-retention.mjs <R> [--json] [--requests <file>] [--ledger-dir <dir>]
// 不写任何文件，不联网。读取 requests 失败（含文件缺失）报错退出 1；行解析失败只计数跳过。
// requests 按行流式读取，不整文件载入内存。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const CATS = ['missing-block', 'missing-lines', 'extra-lines', 'wrong-position', 'unexpected-block'];
const SYS_ROLES = new Set(['system', 'developer']);
const BLOCK_KIND = 'constraint-ledger';
const BLOCK_OPEN = '<standing-constraints>';
const SUB_HEADING = '## Standing Constraints';
const LINE_RE = /^(\d+)\. \[(FORBIDDEN|UNUSABLE|WONTFIX)\] /gm;

const asc = (a, b) => a - b;
const zeroCounts = () => Object.fromEntries(CATS.map((c) => [c, 0]));
const fmt = (a) => `[${a.join(',')}]`;
// 显示用：去掉 session- 前缀后取前 8 位（直接取前 8 位会得到全部相同的 "session-"）。
const shortId = (sid) => (sid ?? '(null)').replace(/^session-/, '').slice(0, 8);

function usage(msg) {
  if (msg) console.error(`参数错误: ${msg}`);
  console.error('用法: node team-retention.mjs <R> [--json] [--requests <file>] [--ledger-dir <dir>]');
  process.exit(2);
}

function parseArgs(argv) {
  let root = null;
  let json = false;
  let requests = null;
  let ledgerDir = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') {
      json = true;
    } else if (a === '--requests' || a === '--ledger-dir') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage(`${a} 缺少值`);
      if (a === '--requests') requests = v;
      else ledgerDir = v;
    } else if (a.startsWith('--')) {
      usage(`未知选项 ${a}`);
    } else if (root === null) {
      root = a;
    } else {
      usage(`多余参数 ${a}`);
    }
  }
  if (root === null && (requests === null || ledgerDir === null)) {
    usage('需要 <R>，或同时给出 --requests 与 --ledger-dir');
  }
  return {
    json,
    root,
    requests: requests ?? path.join(root, 'requests.jsonl'),
    ledgerDir: ledgerDir ?? path.join(root, 'home', 'constraint-ledger'),
  };
}

// 流式逐行读 requests 文件。最后一行可能不完整（另一进程正在追加），解析失败的行计入 skipped。
// 对话请求只保留 inspectBlock 的结果（不保留 rows）；压缩请求整条保留（数量少）。
// 读取失败直接报错（reject），由 main 输出并以退出码 1 结束。
function readRequests(file) {
  const info = { file, status: 'ok', lines: 0, accepted: 0, skipped: 0 };
  const records = [];
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    const fail = (e) => reject(new Error(`读取失败 ${file}: ${e.code || e.message}`, { cause: e }));
    input.on('error', fail);
    rl.on('error', fail);
    rl.on('line', (line) => {
      if (line.trim() === '') return;
      info.lines++;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        info.skipped++;
        return;
      }
      const valid =
        o && typeof o === 'object' &&
        typeof o.at === 'string' && !Number.isNaN(Date.parse(o.at)) &&
        Array.isArray(o.rows);
      if (!valid) {
        info.skipped++;
        return;
      }
      info.accepted++;
      const t = Date.parse(o.at);
      const sid = o.sessionId ?? null;
      if (o.purpose == null) {
        records.push({ at: o.at, t, sid, purpose: null, block: inspectBlock(o) });
      } else if (o.purpose === 'compaction-wire') {
        records.push({ ...o, t, sid });
      }
    });
    rl.on('close', () => resolve({ info, records }));
  });
}

// 读某会话的清单。文件缺失/损坏视为“无清单”（期望无块），并在状态里标明。
function loadLedger(dir, sid) {
  if (typeof sid !== 'string' || sid === '' || /[\\/]/.test(sid)) {
    return { status: 'no-id', entries: [] };
  }
  let text;
  try {
    text = fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8');
  } catch (e) {
    return { status: e.code === 'ENOENT' ? 'missing' : 'unreadable', entries: [] };
  }
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return { status: 'invalid', entries: [] };
  }
  const list = o && Array.isArray(o.entries) ? o.entries : [];
  const entries = [];
  for (const e of list) {
    if (!e || !Number.isInteger(e.n)) continue;
    const addedT = Date.parse(e.addedAt);
    if (Number.isNaN(addedT)) continue;
    // retired 存在但 at 不可解析时，retired.t 为 NaN，下面的比较会把该条目视为已撤销（排除）。
    entries.push({ n: e.n, addedT, retired: e.retired ? { t: Date.parse(e.retired.at) } : null });
  }
  return { status: 'ok', entries };
}

// 期望编号：段首请求时已加入、且在该请求时刻仍未撤销的条目。
function expectedNumbers(entries, segStartT, reqT) {
  const out = new Set();
  for (const e of entries) {
    if (!(e.addedT <= segStartT)) continue;
    if (e.retired && !(e.retired.t > reqT)) continue;
    out.add(e.n);
  }
  return [...out].sort(asc);
}

// 块的位置与内容。tail 不含开头标签则视为 partial，只能看到 tail 里的编号。
function inspectBlock(rec) {
  const rows = rec.rows;
  let lead = 0;
  while (lead < rows.length && rows[lead] && SYS_ROLES.has(rows[lead].role)) lead++;
  const blockAt = rows.findIndex((r) => r && r.kind === BLOCK_KIND);
  if (blockAt < 0) return { present: false, lead };
  const row = rows[blockAt];
  const tail = typeof row.tail === 'string' ? row.tail : '';
  const actual = new Set();
  for (const m of tail.matchAll(LINE_RE)) actual.add(Number(m[1]));
  return {
    present: true,
    lead,
    blockAt,
    positionOk: blockAt === lead,
    bytes: Number(row.bytes) || 0,
    partial: !tail.includes(BLOCK_OPEN),
    actual: [...actual].sort(asc),
  };
}

// 逐请求分类。整块缺失/整块多余时不再重复报告行级问题。
function classify(expected, b) {
  if (!b.present) return expected.length ? { 'missing-block': { expected } } : {};
  const issues = {};
  if (!b.positionOk) issues['wrong-position'] = { blockAt: b.blockAt, lead: b.lead };
  if (expected.length === 0) {
    issues['unexpected-block'] = { actual: b.actual };
    return issues;
  }
  const expSet = new Set(expected);
  const actSet = new Set(b.actual);
  let missing = expected.filter((n) => !actSet.has(n));
  if (b.partial) {
    // partial 时只能判断 >= min(A) 的期望编号。A 为空则不判断缺失。
    missing = b.actual.length ? missing.filter((n) => n >= b.actual[0]) : [];
  }
  const extra = b.actual.filter((n) => !expSet.has(n));
  if (missing.length) issues['missing-lines'] = { missing };
  if (extra.length) issues['extra-lines'] = { extra };
  return issues;
}

function analyzeSession(sid, g, ledgerDir) {
  g.comps.sort((a, b) => a.t - b.t);
  g.convs.sort((a, b) => a.t - b.t);
  const K = g.comps.length;
  const ledger = loadLedger(ledgerDir, sid);

  // 段 k：第 k 次压缩之后、第 k+1 次压缩之前（严格晚于压缩时刻）的对话请求。
  const segConvs = Array.from({ length: K + 1 }, () => []);
  let p = 0;
  for (const c of g.convs) {
    while (p < K && g.comps[p].t < c.t) p++;
    segConvs[p].push(c);
  }

  const segments = [];
  const problems = [];
  let maxBlockBytes = 0;
  for (let k = 0; k <= K; k++) {
    const list = segConvs[k];
    const seg = { k, requests: list.length, ok: 0, partial: 0, withBlock: 0, counts: zeroCounts() };
    const startT = list.length ? list[0].t : null;
    for (const c of list) {
      const b = c.block;
      if (b.present) {
        seg.withBlock++;
        maxBlockBytes = Math.max(maxBlockBytes, b.bytes);
      }
      if (k === 0) continue;
      const expected = expectedNumbers(ledger.entries, startT, c.t);
      const issues = classify(expected, b);
      if (b.present && b.partial) seg.partial++;
      const keys = Object.keys(issues);
      if (keys.length === 0) {
        seg.ok++;
        continue;
      }
      for (const key of keys) seg.counts[key]++;
      problems.push({
        at: c.at,
        seg: k,
        issues,
        expected,
        actual: b.present ? b.actual : null,
        partial: b.present && b.partial,
        blockAt: b.present ? b.blockAt : null,
        lead: b.lead,
      });
    }
    segments.push(seg);
  }

  const compRecords = g.comps.map((c) => {
    const b = inspectBlock(c);
    if (b.present) maxBlockBytes = Math.max(maxBlockBytes, b.bytes);
    const last = c.rows.length ? c.rows[c.rows.length - 1] : null;
    const lastTail = last && typeof last.tail === 'string' ? last.tail : '';
    return {
      at: c.at,
      blockPresent: b.present,
      hasBlock: b.present && b.positionOk,
      hasSubHeading: lastTail.includes(SUB_HEADING),
    };
  });

  return {
    sessionId: sid,
    compactions: K,
    ledgerStatus: ledger.status,
    ledgerEntries: ledger.entries.length,
    segments,
    problems,
    maxBlockBytes,
    compRecords,
  };
}

function totalsOf(sessions) {
  const t = {
    sessions: sessions.length,
    preRequests: 0,
    preWithBlock: 0,
    postRequests: 0,
    ok: 0,
    problemRequests: 0,
    partial: 0,
    counts: zeroCounts(),
    compactions: 0,
    compWithBlock: 0,
    compWithSubHeading: 0,
  };
  for (const s of sessions) {
    for (const seg of s.segments) {
      if (seg.k === 0) {
        t.preRequests += seg.requests;
        t.preWithBlock += seg.withBlock;
        continue;
      }
      t.postRequests += seg.requests;
      t.ok += seg.ok;
      t.partial += seg.partial;
      for (const c of CATS) t.counts[c] += seg.counts[c];
    }
    t.problemRequests += s.problems.length;
    t.compactions += s.compactions;
    t.compWithBlock += s.compRecords.filter((r) => r.hasBlock).length;
    t.compWithSubHeading += s.compRecords.filter((r) => r.hasSubHeading).length;
  }
  return t;
}

function describe(p) {
  const i = p.issues;
  const parts = [];
  if (i['missing-block']) parts.push('missing-block(应有块但没有)');
  if (i['missing-lines']) parts.push(`missing-lines 缺${fmt(i['missing-lines'].missing)}`);
  if (i['extra-lines']) parts.push(`extra-lines 多出${fmt(i['extra-lines'].extra)}`);
  if (i['wrong-position']) parts.push(`wrong-position(blockAt=${p.blockAt} lead=${p.lead})`);
  if (i['unexpected-block']) parts.push(`unexpected-block(应无块, 实有${fmt(i['unexpected-block'].actual)})`);
  const act = p.actual === null ? '实际无块' : `实际${fmt(p.actual)}${p.partial ? ' partial' : ''}`;
  return `${p.at} 段${p.seg} ${parts.join('; ')} | 期望${fmt(p.expected)} ${act}`;
}

function printText(res) {
  const out = [];
  const r = res.requests;
  out.push(`requests: ${r.file} | 状态 ${r.status} | 非空行 ${r.lines} 有效 ${r.accepted} 跳过 ${r.skipped}`);
  out.push(`清单目录: ${res.ledgerDir}`);
  for (const s of res.sessions) {
    out.push('');
    out.push(`会话 ${shortId(s.sessionId)} | 压缩 ${s.compactions} 次 | 清单 ${s.ledgerStatus}(${s.ledgerEntries} 条) | 块最大 bytes ${s.maxBlockBytes || '无块'}`);
    for (const seg of s.segments) {
      if (seg.k === 0) {
        out.push(`  段0(压缩前): 请求 ${seg.requests}, 含块 ${seg.withBlock}（设计上应为 0）`);
        continue;
      }
      const c = CATS.map((name) => `${name} ${seg.counts[name]}`).join(' | ');
      out.push(`  段${seg.k}: 请求 ${seg.requests} | ok ${seg.ok} | partial ${seg.partial} | ${c}`);
    }
    const cw = s.compRecords.filter((x) => x.hasBlock).length;
    const cs = s.compRecords.filter((x) => x.hasSubHeading).length;
    out.push(`  压缩请求: ${s.compactions} 条, 带块(位置正确) ${cw}, 带小节指令 ${cs}`);
    out.push(`  有问题请求 ${s.problems.length} 条${s.problems.length ? '，前 5 条:' : ''}`);
    for (const p of s.problems.slice(0, 5)) out.push(`    ${describe(p)}`);
  }
  const t = res.totals;
  out.push('');
  out.push(`段0(压缩前)请求 ${t.preRequests}, 含块 ${t.preWithBlock} | 跳过行数 ${r.skipped}`);
  const c = CATS.map((name) => `${name} ${t.counts[name]}`).join(', ');
  out.push(
    `总计: 会话 ${t.sessions} | 压缩后对话请求 ${t.postRequests} | ok ${t.ok} | 问题请求 ${t.problemRequests}` +
    ` (${c}) | partial ${t.partial} | 压缩请求 ${t.compactions} 条, 带块 ${t.compWithBlock}, 带小节指令 ${t.compWithSubHeading}`,
  );
  console.log(out.join('\n'));
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const reqRes = await readRequests(opt.requests);

  const groups = new Map();
  for (const rec of reqRes.records) {
    const kind = rec.purpose == null ? 'conv' : rec.purpose === 'compaction-wire' ? 'comp' : null;
    if (!kind) continue;
    if (!groups.has(rec.sid)) groups.set(rec.sid, { comps: [], convs: [] });
    groups.get(rec.sid)[kind === 'comp' ? 'comps' : 'convs'].push(rec);
  }

  const sessions = [];
  for (const [sid, g] of groups) {
    if (g.comps.length === 0) continue;
    sessions.push(analyzeSession(sid, g, opt.ledgerDir));
  }
  sessions.sort((a, b) => String(a.sessionId).localeCompare(String(b.sessionId)));

  const res = {
    requests: reqRes.info,
    ledgerDir: opt.ledgerDir,
    sessions,
    totals: totalsOf(sessions),
  };
  if (opt.json) console.log(JSON.stringify(res, null, 2));
  else printText(res);
}

main().catch((e) => {
  console.error(`内部错误: ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
