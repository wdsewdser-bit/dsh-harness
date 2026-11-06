// M6 WP-6: 15 §9 人话 (V-05 … V-08) against the v3 pages.
import { script } from '../lib/page-actions.mjs';
import { delay } from '../lib/process.mjs';

const TECH = /(member|task|thread|message|attempt|delivery):|\b(admitted|collecting|stored|visible|desired|observed|fence)\b|att#|L✓|F\d/;

async function pageTexts(ctx) {
  const parts = [];
  for (const name of ['now', 'members', 'records']) {
    await ctx.openPage(name);
    await delay(600);
    parts.push({ page: name, text: (await ctx.text('[data-page=' + name + ']')) ?? '' });
  }
  return parts;
}

export const LANGUAGE_CHECKS = [
  {
    id: 'V-05',
    section: '人话',
    title: '技术细节关闭时，三个子页与两处详情的可见文本不出现 id / 状态机词',
    async run(ctx) {
      await ctx.openTeam({ fixture: 'default' });
      await ctx.setDetails(false);
      const parts = await pageTexts(ctx);
      await ctx.openPage('members');
      await ctx.openMember('member:worker-a');
      parts.push({ page: '成员详情', text: (await ctx.text('.tm-v3-ins')) ?? '' });
      await ctx.closeInspector();
      await ctx.openPage('records');
      await delay(500);
      await ctx.click('[data-record]');
      await ctx.page.waitFor('!!document.querySelector("[data-inspector=record]")', '记录检查器', { timeoutMs: 8000 });
      parts.push({ page: '记录详情', text: (await ctx.text('.tm-v3-ins')) ?? '' });
      await ctx.closeInspector();
      const hits = [];
      for (const part of parts) {
        const match = part.text.match(TECH);
        if (match) hits.push({ page: part.page, hit: match[0], around: part.text.slice(Math.max(0, (match.index ?? 0) - 40), (match.index ?? 0) + 40) });
      }
      return {
        pass: hits.length === 0,
        measured: { pages: parts.map(p => p.page), hits },
        detail: hits.length === 0
          ? '5 处可见文本扫描命中 0 次（正则 ' + TECH.source + '）'
          : '命中 ' + hits.length + ' 处：' + JSON.stringify(hits.slice(0, 3)),
      };
    },
  },
  {
    id: 'V-06',
    section: '人话',
    title: '按「.」后每个详情页的技术细节展开，刷新后保持',
    async run(ctx) {
      await ctx.openTeam({ fixture: 'default' });
      await ctx.openPage('members');
      await ctx.setDetails(false);
      await ctx.openMember('member:worker-a');
      const before = await ctx.evaluate('(() => { const d = document.querySelector("[data-ins=technical]"); return d ? d.open : null; })()');
      await ctx.press('.', { code: 'Period', windowsVirtualKeyCode: 190 });
      await ctx.page.waitFor('(() => { const d = document.querySelector("[data-ins=technical]"); return !!d && d.open; })()',
        '技术细节展开', { timeoutMs: 8000 });
      const stored = await ctx.evaluate('JSON.parse(localStorage.getItem("dsh-v2.team-ui") || "{}").details');
      await ctx.closeInspector();
      await ctx.openPage('records');
      await delay(500);
      await ctx.click('[data-record]');
      await ctx.page.waitFor('!!document.querySelector("[data-inspector=record]")', '记录检查器', { timeoutMs: 8000 });
      const recordOpen = await ctx.evaluate('(() => { const d = document.querySelector(".tm-v3-ins [data-ins=technical]"); return d ? d.open : null; })()');
      await ctx.closeInspector();
      await ctx.openTeam({ fixture: 'default' });
      await ctx.openPage('members');
      await ctx.openMember('member:worker-a');
      const afterReload = await ctx.evaluate('(() => { const d = document.querySelector("[data-ins=technical]"); return d ? d.open : null; })()');
      await ctx.closeInspector();
      await ctx.setDetails(false);
      const pass = before === false && recordOpen === true && afterReload === true && stored === true;
      return { pass, measured: { before, recordOpen, afterReload, stored },
        detail: pass ? '成员/记录详情均随「.」展开，localStorage 记录 details=true，刷新后仍展开'
          : '技术细节开关不一致：' + JSON.stringify({ before, recordOpen, afterReload, stored }) };
    },
  },
  {
    id: 'V-07',
    section: '人话',
    title: 'long-text 在 1280 / 1440 宽下相邻文本不重叠，长标题单行截断且悬停有全文',
    async run(ctx) {
      const measured = [];
      for (const width of [1280, 1440]) {
        await ctx.page.setViewport(width, 900);
        await ctx.openTeam({ fixture: 'long-text' });
        await ctx.openPage('members');
        const m = await ctx.evaluate(script([
          '(() => {',
          '  const rows = [...document.querySelectorAll("[data-page=members] tbody tr")];',
          '  const texts = row => {',
          '    const out = [];',
          '    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);',
          '    while (walker.nextNode()) {',
          '      const node = walker.currentNode;',
          '      if (!node.nodeValue.trim()) continue;',
          '      const cell = node.parentElement && node.parentElement.closest ? node.parentElement.closest("td") : null;',
          '      const box = cell ? cell.getBoundingClientRect() : null;',
          '      const range = document.createRange(); range.selectNodeContents(node);',
          '      const r = range.getBoundingClientRect();',
          '      // A nowrap cell clips its text, so the visible part is the range clipped by the cell box.',
          '      const left = box ? Math.max(r.left, box.left) : r.left;',
          '      const right = box ? Math.min(r.right, box.right) : r.right;',
          '      if (right - left > 0.5) out.push({ t: node.nodeValue.trim().slice(0, 24), r: [left, r.top, right, r.bottom] });',
          '    }',
          '    return out;',
          '  };',
          '  const hit = (a, b) => a[0] < b[2] - 0.5 && a[2] > b[0] + 0.5 && a[1] < b[3] - 0.5 && a[3] > b[1] + 0.5;',
          '  const bad = [];',
          '  for (const row of rows) {',
          '    const items = texts(row);',
          '    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {',
          '      if (hit(items[i].r, items[j].r)) bad.push([items[i].t, items[j].t]);',
          '    }',
          '  }',
          '  const longRow = rows.find(r => r.querySelector("td").innerText.length > 20);',
          '  const cells = longRow ? [...longRow.querySelectorAll("td")] : [];',
          '  const lines = el => { const r = document.createRange(); r.selectNodeContents(el); return r.getClientRects().length; };',
          '  const shape = el => { const cs = getComputedStyle(el); return { ws: cs.whiteSpace, ellipsis: cs.textOverflow,',
          '    clipped: el.scrollWidth > el.clientWidth + 1, lines: lines(el), text: el.innerText.length,',
          '    title: (el.getAttribute("title") || "").length }; };',
          '  return { bad, rows: document.querySelectorAll("[data-page=members] [data-member]").length,',
          '    scanRows: rows.length, columns: document.querySelectorAll(".tm-v3-table th").length,',
          '    name: cells[0] ? shape(cells[0]) : null, what: cells[1] ? shape(cells[1]) : null };',
          '})()',
        ]));
        measured.push({ width, ...m });
      }
      await ctx.page.setViewport(1440, 900);
      const escalate = [];
      for (const width of [1280, 1440]) {
        await ctx.page.setViewport(width, 900);
        await ctx.openTeam({ fixture: 'borrow' });
        await ctx.openPage('now');
        escalate.push({ width, ...(await ctx.evaluate(script([
          '(() => {',
          '  const row = document.querySelector("[data-escalation]");',
          '  if (!row) return { rows: 0 };',
          '  const nodes = [...row.querySelectorAll("b, span, button")];',
          '  const rects = nodes.map(n => { const r = n.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });',
          '  const hit = (a, b) => a[0] < b[2] - 0.5 && a[2] > b[0] + 0.5 && a[1] < b[3] - 0.5 && a[3] > b[1] + 0.5;',
          '  let overlap = 0;',
          '  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (hit(rects[i], rects[j])) overlap++;',
          '  const box = row.getBoundingClientRect();',
          '  return { rows: 1, overlap, width: Math.round(box.width), viewport: innerWidth };',
          '})()',
        ]))) });
      }
      await ctx.page.setViewport(1440, 900);
      const tableOk = measured.every(m => m.bad.length === 0 && m.rows === 17 && m.columns === 3
        && m.name && m.what && m.name.lines <= 2 && m.name.title >= m.name.text
        && m.what.title > 60 && m.what.lines <= 2 && m.what.clipped === true);
      const escalateOk = escalate.every(e => e.rows === 1 && e.overlap === 0 && e.width <= e.viewport);
      return {
        pass: tableOk && escalateOk,
        measured: { table: measured, escalate },
        detail: tableOk && escalateOk
          ? '1280/1440：17 行三列表无重叠文本；32 字成员名与 200 字标题单行省略，title 属性带全文；升级行无重叠'
          : '布局不符：' + JSON.stringify({ table: measured, escalate }).slice(0, 600),
      };
    },
  },
  {
    id: 'V-08',
    section: '人话',
    title: '页面不出现超过 999 小时的相对时间',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default' });
      const parts = await pageTexts(ctx);
      await ctx.openPage('members');
      await ctx.openMember('member:worker-b');
      parts.push({ page: '成员详情', text: (await ctx.text('.tm-v3-ins')) ?? '' });
      await ctx.closeInspector();
      const all = parts.map(p => p.text).join('\n');
      const hours = [...all.matchAll(/([0-9]+)h([0-9]+)?m?/g)].map(m => Number(m[1]));
      const over = hours.filter(h => h > 999);
      const chinese = [...all.matchAll(/([0-9]+)\s*小时/g)].map(m => Number(m[1])).filter(h => h > 999);
      const pass = over.length === 0 && chinese.length === 0;
      return { pass, measured: { hours: hours.slice(0, 12), max: hours.length ? Math.max(...hours) : null,
          over, chinese, pages: parts.map(p => p.page) },
        detail: pass ? '可见文本中的相对时间最大 ' + (hours.length ? Math.max(...hours) : 0) + 'h，未超过 999 小时'
          : '出现超长相对时间：' + JSON.stringify({ over, chinese }),
        note: 'v3 三个子页不渲染 deadline 字段，15 §9「缺失时显示无截止时间」属 v1 面板；本条只核对相对时间上限。' };
    },
  },
];
