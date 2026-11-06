// M6 WP-6: 15 §9 作用域 (V-01 … V-04) against the v3 pages (16 §2 states what v3 removed).
import { script } from '../lib/page-actions.mjs';

const TEAM_A_TITLE = '迁移渲染管线到 v2';
const TEAM_B_TITLE = '团队 B：只为隔离验收存在的目标';
const MEMBER_NAMES = ['worker-a', 'worker-b', 'verifier-e', 'worker-p1', 'member:root', 'sc-1'];

export const SCOPE_CHECKS = [
  {
    id: 'V-01',
    section: '作用域',
    title: '普通会话（无团队）只显示空态，不残留任何成员名',
    async run(ctx) {
      await ctx.openTeam({ fixture: 'empty' });
      const seen = await ctx.evaluate(script([
        '(() => {',
        '  const empty = document.querySelector("[data-empty=no-team]");',
        '  return {',
        '    text: empty ? empty.innerText : null,',
        '    roster: !!document.querySelector(".tm-roster"),',
        '    strip: !!document.querySelector(".tm-strip"),',
        '    tabs: document.querySelectorAll("[data-tab]").length,',
        '    members: document.querySelectorAll("[data-member]").length,',
        '    body: document.body.innerText,',
        '  };',
        '})()',
      ]));
      const leaked = MEMBER_NAMES.filter(name => seen.body.includes(name));
      const pass = !!seen.text && seen.text.includes('这个会话没有团队') && !seen.roster && !seen.strip
        && seen.tabs === 0 && seen.members === 0 && leaked.length === 0;
      return {
        pass,
        detail: pass
          ? '空态「这个会话没有团队」；左栏无团队区块、无会话条带、无子页标签；DOM 中 0 个成员名'
          : '空态不符：' + JSON.stringify({ text: seen.text, roster: seen.roster, strip: seen.strip,
            tabs: seen.tabs, members: seen.members, leaked }),
        note: '15 §9 的文案是「这个会话没有开启团队模式」；v3 §4 空态定为「这个会话没有团队」，按 v3 判定。',
      };
    },
  },
  {
    id: 'V-02',
    section: '作用域',
    title: '两个团队之间来回切换 10 次，标题行与成员表始终属于当前团队',
    async run(ctx) {
      const seen = [];
      for (let round = 0; round < 10; round += 1) {
        const fixture = round % 2 === 0 ? 'two-teams' : 'default';
        await ctx.openTeam({ fixture });
        await ctx.openPage('members');
        const row = await ctx.evaluate(script([
          '(() => {',
          '  const rows = [...document.querySelectorAll("[data-page=members] [data-member]")];',
          '  const header = document.querySelector(".tm-v3-team");',
          '  return {',
          '    team: header ? header.innerText : null,',
          '    names: rows.map(r => r.querySelector("td").innerText),',
          '    summary: document.querySelector("[data-v3=member-summary]") ? true : false,',
          '  };',
          '})()',
        ]));
        const teamB = fixture === 'two-teams';
        const leaked = teamB ? row.names.filter(name => !name.startsWith('b-')) : row.names.filter(name => name.startsWith('b-'));
        const headerOk = row.team === (teamB ? TEAM_B_TITLE : TEAM_A_TITLE);
        const ok = headerOk && leaked.length === 0 && row.names.length === 17 && row.summary;
        seen.push({ round: round + 1, fixture, headerOk, rows: row.names.length, leaked });
        if (!ok) {
          return { pass: false, measured: seen,
            detail: '第 ' + (round + 1) + ' 次切换后出现跨团队内容：' + JSON.stringify(seen[seen.length - 1]) };
        }
      }
      return { pass: true, measured: seen,
        detail: '10 次切换：标题行与 17 行成员表全部属于当前团队，未出现另一团队的名字',
        note: '切换用夹具导航（每次重建投影作用域）；SSE 晚到事件按 teamId 丢弃由 projection/scope 单测覆盖，'
          + 'mock 只有单一绑定，造不出两个原生会话。' };
    },
  },
  {
    id: 'V-03',
    section: '作用域',
    title: 'projection 请求带 team=A；用 A 的令牌请求 team=B 返回 404',
    na: '适用性：夹具模式用浏览器内 mock 源（createMockSource），不存在 HTTP projection 请求与 404 语义；'
      + '该条属 packages/projections 的服务端契约，由其测试覆盖，浏览器验收无法伪造成 HTTP 调用。',
  },
  {
    id: 'V-04',
    section: '作用域',
    title: '左栏会话列表里团队会话只带「团队」标记，没有人数和状态',
    na: '适用性：左栏会话列表由上游 DSH 渲染，插件不改它（16 §2：左栏只保留 C2-a 团队区块与 L0 条带）；'
      + 'mock 页面只有当前一个会话，无法构造两个团队会话的列表。SessionMini 的标记逻辑由 packages/ui 单测覆盖。',
  },
];
