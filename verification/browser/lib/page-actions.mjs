// M6 WP-6: the page-level actions every check shares. It hides the DSH shell (fixture navigation, the first-run
// notice, the Team panel selection) so a check only talks about the Team UI it verifies.
import { delay } from './process.mjs';

/** A page expression written as readable lines; injected as one script. */
export const script = lines => lines.join('\n');

/**
 * A write control still looks like 「发话…」/「退役…」 in v3. Status text and filter chips also contain these words
 * ("1 暂停、1 退役中", "root 的裁决"), so the classification reads the first line and requires a leading verb.
 */
export const WRITE_LABEL = /^(发话|冻结|退役|恢复|取消|改投|审批|裁决|去决定|发消息|暂停)/;
export function isWriteLabel(label) {
  const first = String(label ?? '').trim().split('\n')[0].trim();
  return WRITE_LABEL.test(first);
}

/**
 * The native web host shows a first-run "Preview Notice" behind an inert overlay and a "Get started" dialog. Both
 * swallow real input (focus and keys), so every entry closes them before a check runs. Returns whether the overlay is
 * gone; a still-inert page fails the run instead of producing "clicks that do nothing".
 */
export async function settleShell(page, { timeoutMs = 9000, quietMs = 600 } = {}) {
  const end = Date.now() + timeoutMs;
  let quietSince = null;
  while (Date.now() < end) {
    const state = await page.evaluate(script([
      '(() => {',
      // Only the native shell's dialogs: the Team UI owns role=dialog elements too (palette, narrow sheet).
      '  const dialogs = [...document.querySelectorAll("[role=dialog]")]',
      '    .filter(d => !d.closest(".tm"));',
      // Since 0.2.2-rc.1 the folded sidebar is itself role=dialog (aria-label Navigation) below the drawer breakpoint,
      // so "the first native dialog" is no longer the onboarding one. Preview Notice -> Get started is the chain.
      '  const onboarding = dialogs.find(d => !/^Navigation$/.test(d.getAttribute("aria-label") || ""));',
      '  const close = onboarding ? onboarding.querySelector("[aria-label=Close], [aria-label=关闭]") : null;',
      '  const root = document.getElementById("root");',
      '  const cont = [...document.querySelectorAll("button")]',
      '    .find(b => /^(Continue|继续)$/.test((b.innerText || "").trim()));',
      '  if (onboarding && !cont && !close) return "stuck";',
      '  if (cont) { cont.click(); return "continue"; }',
      '  if (close) { close.click(); return "close"; }',
      // rc.1 keeps the closed sidebar column inert while it is folded; that subtree is not a lock on the app. The shell
      // is locked when the app root itself is inert, which is what an undismissed onboarding scrim sets.
      '  if (root && root.hasAttribute("inert")) return "stuck";',
      '  return "clean";',
      '})()',
    ]));
    if (state !== 'clean') { quietSince = null; await delay(250); continue; }
    // The notice mounts ~300ms after load, so "clean once" is not enough: require a quiet window.
    quietSince = quietSince ?? Date.now();
    if (Date.now() - quietSince >= quietMs) return true;
    await delay(150);
  }
  return false;
}

export function createPageActions({ page, origin }) {
  const evaluate = expression => page.evaluate(expression);
  const selector = sel => JSON.stringify(sel);
  const text = sel => evaluate('(() => { const e = document.querySelector(' + selector(sel) + '); return e ? e.innerText : null; })()');
  const count = sel => evaluate('document.querySelectorAll(' + selector(sel) + ').length');
  const exists = sel => evaluate('!!document.querySelector(' + selector(sel) + ')');
  const click = sel => evaluate('(() => { const e = document.querySelector(' + selector(sel) + ');'
    + ' if (!e) return false; e.click(); return true; })()');
  const ui = () => evaluate('window.__dshTeam.ui.getSnapshot()');

  /** Open a fixture in its own scope and land on the Team panel. A navigation rebuilds the projection client. */
  async function openTeam({ fixture = 'default', viewer = null, ready = null } = {}) {
    const url = origin + '/?teamFixture=' + encodeURIComponent(fixture)
      + (viewer ? '&teamViewer=' + encodeURIComponent(viewer) : '');
    await page.navigate(url);
    await page.waitFor('!!window.__dshTeam && !!window.__dshTeam.client', '团队插件挂载', { timeoutMs: 60000 });
    if (!await settleShell(page)) throw Error('宿主遮罩仍为 inert：点击与按键会被吞掉（fixture ' + fixture + '）');
    await page.waitFor(script([
      '(() => { const s = window.__dshTeam.client.getSnapshot();',
      '  return s.status === "ready" && (!!s.data || s.binding === null); })()',
    ]), '会话作用域绑定', { timeoutMs: 45000 });
    await evaluate('window.__dshTeam.nav.showTeam()');
    // Every check starts on 「现在」: the subpage is a per-tab preference, and a leftover tab would decide a check.
    await evaluate('(() => { const s = window.__dshTeam.client.getSnapshot();'
      + ' if (s.data) window.__dshTeam.ui.setPage("now"); })()');
    const target = ready ?? '!!document.querySelector(".tm-v3-top")';
    if (fixture === 'empty' && !ready) {
      // The no-team empty state appears once a session without a team is the selected one. If the shell has not
      // picked a session yet, selecting the mock's "no team" session is what a person would do in the session list.
      try {
        await page.waitFor('!!document.querySelector("[data-empty=no-team]")', '无团队空态', { timeoutMs: 12000 });
      } catch {
        await evaluate('window.__dshTeam.client.switchSession("session:none")');
        await page.waitFor('!!document.querySelector("[data-empty=no-team]")', '无团队空态', { timeoutMs: 20000 });
      }
    } else {
      await page.waitFor(target, 'Team 页面就绪', { timeoutMs: 30000 });
    }
    await delay(150);
    return url;
  }

  /** Switch one of the three subpages; the tab click is what a person does, setPage is the fallback for narrow layouts. */
  async function openPage(name) {
    const clicked = await click('[data-tab="' + name + '"]');
    if (!clicked) await evaluate('window.__dshTeam.ui.setPage(' + JSON.stringify(name) + ')');
    await page.waitFor('!!document.querySelector(' + selector('[data-page="' + name + '"]') + ')', name + ' 子页',
      { timeoutMs: 15000 });
    await delay(200);
  }

  /** The technical-details layer is global ('.'); checks that read human text need it off, V-06 needs it on. */
  async function setDetails(on) {
    if ((await ui()).details === on) return;
    await click('.tm-v3-details');
    await page.waitFor('window.__dshTeam.ui.getSnapshot().details === ' + String(on), '技术细节开关 ' + String(on),
      { timeoutMs: 8000 });
  }

  async function press(key, options) {
    if (!await settleShell(page)) throw Error('宿主遮罩在按键前无法关闭：' + key);
    return page.press(key, options);
  }

  return { page, origin, evaluate, text, count, exists, click, ui, openTeam, openPage, setDetails, press,
    /** Key events reach React handlers only from inside the page: focus the panel before pressing a letter. */
    focusPage: () => evaluate('document.querySelector(".tm-page")?.focus()'),
    openMember(id) {
      return (async () => {
        const row = '[data-member="' + id + '"]';
        await click(row);
        await page.waitFor('!!document.querySelector("[data-inspector=member]")', '成员检查器', { timeoutMs: 8000 });
        await delay(150);
      })();
    },
    closeInspector: () => click('.tm-v3-close'),
  };
}