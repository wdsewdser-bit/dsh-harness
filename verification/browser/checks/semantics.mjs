// M6 WP-6: 15 §9 新语义 (V-14 … V-20). v3 merged the old task/message/proposal/pending pages into
// 「成员」与「记录」(16 §2), so several v2 items are not renderable by design; each says why.
import { script } from '../lib/page-actions.mjs';
import { delay } from '../lib/process.mjs';

export const SEMANTICS_CHECKS = [
  {
    id: 'V-14',
    section: '新语义',
    title: '成员活动三态（运行/空闲/维护）在成员表里可区分',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default' });
      await ctx.openPage('members');
      const rows = await ctx.evaluate(script([
        '[...document.querySelectorAll("[data-page=members] [data-member]")].map(r => {',
        '  const st = r.querySelector("[data-status]");',
        '  const dot = st ? getComputedStyle(st, "::before").backgroundColor : null;',
        '  return { id: r.getAttribute("data-member"), key: st ? st.getAttribute("data-status") : null,',
        '    text: st ? st.innerText : null, sev: st ? st.getAttribute("data-sev") : null, dot,',
        '    doing: r.querySelectorAll("td")[1] ? r.querySelectorAll("td")[1].innerText : null };',
        '})',
      ]));
      const pick = key => rows.find(row => row.key === key) ?? null;
      const running = pick('running'), idle = pick('idle'), maintenance = pick('maintenance');
      const texts = [running?.text, idle?.text, maintenance?.text];
      const distinct = new Set(texts).size === 3 && new Set([running?.sev, idle?.sev, maintenance?.sev]).size === 3
        && new Set([running?.dot, idle?.dot, maintenance?.dot]).size === 3;
      // 「在做什么」shows the task title first, so the maintenance wording is optional when the member holds a task.
      const doingOk = [running?.doing, idle?.doing, maintenance?.doing].every(text => typeof text === 'string' && text.length > 0);
      const pass = !!running && !!idle && !!maintenance && distinct && doingOk;
      return { pass, measured: { running, idle, maintenance, statuses: rows.map(r => r.key) },
        detail: pass
          ? '运行=' + running.text + ' / 空闲=' + idle.text + ' / 维护=' + maintenance.text
            + '：文案、颜色（data-sev）与圆点底色三者都不同'
          : '三态不可区分：' + JSON.stringify({ running, idle, maintenance }).slice(0, 400),
        note: '15 §9 的措辞是「运行中 · 〈工具〉〈时长〉」；v3 §3.2 固定为「正常/空闲/卡住/已暂停/退役中」，'
          + '工具与时长移到「在做什么」列，本条按 v3 判定。' };
    },
  },
  {
    id: 'V-15',
    section: '新语义',
    title: '消息「已送达未看到」与「看到」在记录里可区分，且不出现「已读」',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default' });
      await ctx.openPage('records');
      await delay(700);
      let text = (await ctx.text('[data-page=records]')) ?? '';
      let pages = 1;
      while (pages < 3 && !(text.includes('已送达信箱') && text.includes('已看到')) && await ctx.exists('.tm-v3-more')) {
        await ctx.click('.tm-v3-more');
        await delay(800);
        text = (await ctx.text('[data-page=records]')) ?? '';
        pages += 1;
      }
      const pass = text.includes('已送达信箱') && text.includes('已看到') && !text.includes('已读');
      const linesOf = word => text.split('\n').filter(line => line.includes(word)).slice(0, 2);
      return { pass, measured: { pages, stored: linesOf('已送达信箱'), visible: linesOf('已看到'),
          hasRead: text.includes('已读') },
        detail: pass
          ? '记录第 ' + pages + ' 页同时含「已送达信箱」与「已看到」，全文没有「已读」'
          : '消息状态文案不符：' + JSON.stringify({ stored: linesOf('已送达信箱'), visible: linesOf('已看到'),
            hasRead: text.includes('已读') }),
        note: '15 §9 的「已送达 · 还没看到」是 v2 消息页的措辞；v3 把消息并入记录，状态按 ACTIVITY_STATE_TEXT 呈现，'
          + '本条按 v3 判定。' };
    },
  },
  {
    id: 'V-16',
    section: '新语义',
    title: '提议倒计时每秒递减、25% 变琥珀、归零后结算',
    na: '适用性：v3 默认不显示协作提议面板与倒计时环（16 §2：提议并入记录、细节在右栏）；'
      + 'mock 的 intent 夹具也没有倒计时/反对注入。倒计时状态机属 packages/ui 的 intent 单测。',
  },
  {
    id: 'V-17',
    section: '新语义',
    title: 'unseenAtPass 非空的已通过提议显示「▲ 通过时〈人〉还没看到」',
    na: '适用性：同 V-16——v3 三子页不渲染提议对象，mock 的 intents 面板块也没有 unseenAtPass 数据；'
      + '该文案由 labels.mjs 的 INTENT_TEXT 与单测覆盖。',
  },
  {
    id: 'V-18',
    section: '新语义',
    title: '死信出现在待处理分组，改投走命令面板并替换死信行',
    na: '适用性：被 2026-11-05 决定 #12 与 16 §2 第 19 行取代——死信改投不进人的视图，由 root 收件箱处理，'
      + '结果写进记录；v3 没有「待处理」子页。死信的 admission/rebind 由 packages/core 的测试覆盖。',
  },
  {
    id: 'V-19',
    section: '新语义',
    title: 'read-model 类 unknown 不计入「需要你的事」，而真实升级会计入',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'unknown+deadletter' });
      const readModelText = (await ctx.text('[data-page=now]')) ?? '';
      const readModelCount = await ctx.count('[data-escalation]');
      await ctx.openTeam({ fixture: 'borrow' });
      await ctx.openPage('now');
      const capacityText = (await ctx.text('[data-page=now]')) ?? '';
      const capacityCount = await ctx.count('[data-escalation]');
      const pass = readModelCount === 0 && !/read-model|读模型|数据缺口/.test(readModelText)
        && capacityCount === 1 && capacityText.includes('结果不明');
      return { pass, measured: { readModelCount, capacityCount,
          capacityLine: capacityText.split('\n').filter(l => l.includes('结果不明'))[0] ?? null },
        detail: pass
          ? 'read-model unknown 不进「需要你的事」（0 条）；容量 unknown 会计入（1 条，说明行点名 operator）'
          : 'unknown 归类不符：' + JSON.stringify({ readModelCount, capacityCount }).slice(0, 300),
        note: 'v3 没有「数据缺口」分组（16 §2），read-model 缺口不出现在人的视图里——本条的判据是「不计入需要你」。' };
    },
  },
  {
    id: 'V-20',
    section: '新语义',
    title: '退役请求超过 3 分钟未收敛时行变琥珀并在待处理出现',
    na: '适用性：mock 夹具里没有「已请求退役但未收敛」的成员（只有已退役的 worker-g3），也没有「待处理」子页；'
      + 'v3 的成员表只保留「退役中…」状态，3 分钟升级规则由 projections 的 retirement 用例覆盖。',
  },
];
