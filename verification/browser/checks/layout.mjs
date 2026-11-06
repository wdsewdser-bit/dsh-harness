// M6 WP-6: 15 §9 布局、键盘、回归 (V-21 … V-24), read through the v3 narrow layout (16 §4) and the v3 token rule.
import { script, isWriteLabel } from '../lib/page-actions.mjs';
import { delay } from '../lib/process.mjs';

export const LAYOUT_CHECKS = [
  {
    id: 'V-21',
    section: '布局、键盘、回归',
    title: '480×900：子页标签在标题行可见、成员表单行截断、详情为全屏抽屉（Esc / ← 返回 关闭并交还焦点）',
    async run(ctx) {
      await ctx.page.setViewport(480, 900);
      await ctx.openTeam({ fixture: 'default' });
      const head = await ctx.evaluate(script([
        '(() => {',
        '  const tabs = document.querySelector(".tm-v3-tabs");',
        '  const top = document.querySelector(".tm-v3-top");',
        '  const rect = tabs ? tabs.getBoundingClientRect() : null;',
        '  return { mode: document.querySelector(".tm-page").getAttribute("data-mode"),',
        '    tabs: rect ? [Math.round(rect.left), Math.round(rect.right), Math.round(rect.width)] : null,',
        '    topHeight: top ? Math.round(top.getBoundingClientRect().height) : null,',
        '    tabCount: document.querySelectorAll("[data-tab]").length };',
        '})()',
      ]));
      await ctx.openTeam({ fixture: 'long-text' });
      await ctx.openPage('members');
      const table = await ctx.evaluate(script([
        '(() => {',
        '  const cells = [...document.querySelectorAll(".tm-v3-table .tm-v3-what")];',
        '  const what = cells.reduce((best, el) => (el.innerText.length > best.innerText.length ? el : best), cells[0]);',
        '  const cs = what ? getComputedStyle(what) : {};',
        '  return { rows: document.querySelectorAll("[data-page=members] [data-member]").length,',
        '    columns: document.querySelectorAll(".tm-v3-table th").length,',
        '    whiteSpace: cs.whiteSpace ?? null, ellipsis: cs.textOverflow ?? null,',
        '    clipped: what ? what.scrollWidth > what.clientWidth + 1 : null };',
        '})()',
      ]));
      await ctx.openTeam({ fixture: 'default' });
      await ctx.openPage('records');
      await delay(700);
      const focusOf = script([
        '(() => ({ drawer: window.__dshTeam.ui.getSnapshot().drawer,',
        '  record: document.activeElement && document.activeElement.getAttribute',
        '    ? document.activeElement.getAttribute("data-record") : null }))()',
      ]);
      await ctx.click('[data-record]');
      await ctx.page.waitFor('!!document.querySelector(".tm-v3-sheet")', '全屏详情抽屉', { timeoutMs: 8000 });
      await delay(300);
      const sheet = await ctx.evaluate(script([
        '(() => {',
        '  const el = document.querySelector(".tm-v3-sheet");',
        '  const r = el.getBoundingClientRect();',
        '  const back = el.querySelector(".tm-v3-back");',
        '  return { role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"),',
        '    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],',
        '    viewport: [innerWidth, innerHeight], back: back ? back.innerText.trim() : null,',
        '    scrim: !!document.querySelector(".tm-scrim") };',
        '})()',
      ]));
      await ctx.press('Escape', { code: 'Escape', windowsVirtualKeyCode: 27 });
      await ctx.page.waitFor('!document.querySelector(".tm-v3-sheet")', 'Esc 关闭全屏抽屉', { timeoutMs: 8000 });
      const afterEsc = await ctx.evaluate(focusOf);
      await ctx.click('[data-record]');
      await ctx.page.waitFor('!!document.querySelector(".tm-v3-sheet")', '再次打开全屏抽屉', { timeoutMs: 8000 });
      await ctx.click('.tm-v3-back');
      await ctx.page.waitFor('!document.querySelector(".tm-v3-sheet")', '「← 返回」关闭全屏抽屉', { timeoutMs: 8000 });
      const afterBack = await ctx.evaluate(focusOf);
      const headOk = head.mode === 'narrow' && head.tabCount === 3 && !!head.tabs
        && head.tabs[2] > 0 && head.tabs[1] <= 480 && head.topHeight <= 60;
      const tableOk = table.rows === 17 && table.columns === 3 && table.whiteSpace === 'nowrap'
        && table.ellipsis === 'ellipsis' && table.clipped === true;
      const sheetOk = sheet.role === 'dialog' && sheet.modal === 'true' && sheet.back === '← 返回'
        && sheet.rect[0] === 0 && sheet.rect[1] === 0
        && sheet.rect[2] === sheet.viewport[0] && sheet.rect[3] === sheet.viewport[1];
      const escOk = afterEsc.drawer === null && !!afterEsc.record;
      const backOk = afterBack.drawer === null && !!afterBack.record;
      const pass = headOk && tableOk && sheetOk && escOk && backOk;
      return { pass, measured: { head, table, sheet, afterEsc, afterBack },
        detail: pass
          ? '标题行 3 个子页标签可见（顶栏 ' + head.topHeight + 'px）；成员表 3 列、在做什么列单行省略；'
            + '详情为 ' + sheet.rect[2] + '×' + sheet.rect[3] + ' 全屏抽屉，顶部「← 返回」，'
            + 'Esc 与「← 返回」都能关闭并把焦点还给触发行'
          : '480 布局不符：' + JSON.stringify({ head, table, sheet, afterEsc, afterBack }).slice(0, 500),
        note: '15 §9 的 v2 版要求「底部页签 + 成员两行」；v3 §4 改为子页标签放标题行、在做什么列一行截断、'
          + '右栏为全屏抽屉（顶部「← 返回」），本条按 v3 判定；禁用原因在 v3 已无禁用按钮，该项不适用。' };
    },
  },
  {
    id: 'V-22',
    section: '布局、键盘、回归',
    title: '不用鼠标：g t → 5 → j → o → a 完成死信改投',
    na: '适用性：这套键盘方案属 v2（15 §6.6）的五个子页结构；v3 只保留 g t / g r 和弦、「.」、「a」、「Esc」，'
      + '死信改投也已移出人的视图。v3 的键盘行为在 V-06（.）、V-12（a）、V-21（Esc）里逐项核对。',
  },
  {
    id: 'V-23',
    section: '布局、键盘、回归',
    title: '绿色（--tm-done）只出现在「已验收」上（文本色、背景色、边框色）',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default' });
      const scan = [];
      for (const name of ['now', 'members', 'records']) {
        await ctx.openPage(name);
        await delay(name === 'records' ? 700 : 250);
        scan.push({ page: name, ...(await ctx.evaluate(script([
          '(() => {',
          '  const root = document.querySelector(".tm-page");',
          '  const probe = document.createElement("div");',
          '  probe.style.color = "var(--tm-done)";',
          '  root.appendChild(probe);',
          '  const done = getComputedStyle(probe).color;',
          '  probe.remove();',
          '  const context = el => {',
          '    let node = el, text = "";',
          '    for (let i = 0; i < 4 && node && !text; i++) { text = (node.textContent || "").trim(); node = node.parentElement; }',
          '    return text.slice(0, 60);',
          '  };',
          '  const hits = [];',
          '  for (const el of root.querySelectorAll("*")) {',
          '    const cs = getComputedStyle(el);',
          '    const sides = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];',
          '    const color = cs.color === done, bg = cs.backgroundColor === done, border = sides.includes(done);',
          '    if (!color && !bg && !border) continue;',
          '    hits.push({ tag: el.tagName, cls: String(el.className || "").slice(0, 24), color, bg, border,',
          '      text: context(el) });',
          '  }',
          '  return { done, hits };',
          '})()',
        ]))) });
      }
      const done = scan[0].done;
      const hits = scan.flatMap(item => item.hits.map(hit => ({ page: item.page, ...hit })));
      const bad = hits.filter(hit => !/已验收|✓/.test(hit.text));
      const pass = bad.length === 0 && hits.length > 0;
      return { pass, measured: { done, hits, bad },
        detail: pass
          ? '三个子页共 ' + hits.length + ' 处使用 --tm-done（' + done + '）：'
            + hits.map(hit => hit.page + '/' + hit.tag + (hit.bg ? '·背景' : '')
              + (hit.color ? '·文本' : '') + (hit.border ? '·边框' : '')).join('、')
          : '绿色用途不符：' + JSON.stringify(bad.length ? bad : { hits: hits.length }).slice(0, 400),
        note: '判据覆盖 color / background-color / 四边 border-color，并要求至少有一处（进度条）使用该 token，避免零命中即通过；'
          + '记录分类圆点改用 --tm-wait（进行中），“已产出”这类非验收行不再出现绿色。' };
    },
  },
  {
    id: 'V-24',
    section: '布局、键盘、回归',
    title: '回归：过期提示（A4）与无写路径（A9）仍成立',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default' });
      await ctx.openPage('now');
      const beforeBadge = await ctx.exists('[data-fresh]');
      await ctx.evaluate('window.__dshTeam.control.setStale(true)');
      await ctx.page.waitFor('!!document.querySelector("[data-fresh]")', '过期徽标', { timeoutMs: 8000 });
      const staleBadge = await ctx.text('[data-fresh]');
      await ctx.evaluate('window.__dshTeam.control.setStale(false)');
      await ctx.page.waitFor('!document.querySelector("[data-fresh]")', '过期徽标消失', { timeoutMs: 8000 });
      await ctx.openTeam({ fixture: 'default', viewer: 'viewer:readonly' });
      const buttons = await ctx.evaluate(script([
        '[...new Set([...document.querySelectorAll(".tm-page button, .tm-roster button")].map(b => (b.innerText || "").trim()))]',
      ]));
      const writes = buttons.filter(isWriteLabel);
      const pass = beforeBadge === false && staleBadge === '数据不新鲜' && writes.length === 0;
      return { pass, measured: { beforeBadge, staleBadge, writes },
        detail: pass
          ? '服务端 stale 时标题行出现「数据不新鲜」并随恢复消失；viewer 页面 0 个写按钮'
          : '回归不符：' + JSON.stringify({ beforeBadge, staleBadge, writes }).slice(0, 300),
        note: 'A1（default 视觉无变化）属像素对照工具（patches/upstream-0.2.2-alpha.2/team-layout/verify-pixels.mjs），'
          + '不在浏览器入口重复；本条取 A4 的过期提示与 A9 的无写路径。' };
    },
  },
];