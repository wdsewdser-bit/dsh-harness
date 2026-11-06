// M6 WP-6: 15 §9 禁用/查看/只读 (V-09 … V-13), read through v3's rule "没有权限的操作不显示" (16 §1-4).
import { script, isWriteLabel } from '../lib/page-actions.mjs';
import { delay } from '../lib/process.mjs';

export const PERMISSION_CHECKS = [
  {
    id: 'V-09',
    section: '禁用、查看、只读',
    title: 'frozen 夹具：写按钮禁用并在按钮下显示原因',
    na: '适用性：mock 夹具集里没有 frozen（15 §9 前置的 writable/frozen 夹具未在 packages/ui/src/mock.mjs 实现），'
      + '而 v3 已整条删除「禁用按钮 + 原因」（16 §2 第 18 行）与页顶冻结横幅；补夹具要改 packages/ui，'
      + '不在 WP-6 允许路径内。冻结语义（completionToken → COMPLETION_FROZEN）由 commands 的单测覆盖。',
  },
  {
    id: 'V-10',
    section: '禁用、查看、只读',
    title: '组长身份下「结果不明」的「裁决」禁用并写明只有 operator 能裁决',
    na: '适用性：被 2026-11-05 决定 #12 取代——v3 不放禁用按钮，改为一行说明（22 §6 #12）。'
      + '浏览器也不具备 operator 身份，裁决只由 operator 侧提交。说明行的可达性在 V-19 的 borrow 夹具里核对。',
  },
  {
    id: 'V-11',
    section: '禁用、查看、只读',
    title: 'operator 身份下同一行的「裁决…」可用并能提交出 receipt',
    na: '适用性：浏览器只能以团队成员身份认证，裁决（delivery.reconcile / mailbox.resolveUnknown）在服务端只接受 operator；'
      + 'mock 的 gateway 对非 operator 一律 ROLE_DENIED。该条由 projections/gateway 的 operator 用例覆盖，浏览器无法构造。',
  },
  {
    id: 'V-12',
    section: '禁用、查看、只读',
    title: 'viewer 只读：只读徽标、无任何写按钮、右栏是说明块、按 a 说明身份',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default', viewer: 'viewer:readonly' });
      const badge = await ctx.text('[data-readonly=viewer]');
      const buttons = await ctx.evaluate(script([
        '[...new Set([...document.querySelectorAll(".tm-page button, .tm-roster button")].map(b => (b.innerText || "").trim()))]',
      ]));
      const writes = buttons.filter(isWriteLabel);
      await ctx.openPage('members');
      await ctx.openMember('member:worker-a');
      const actions = await ctx.text('[data-readonly=actions]');
      await ctx.closeInspector();
      await ctx.focusPage();
      await ctx.press('a', { code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' });
      await delay(300);
      const toast = await ctx.text('.tm-v3-toast');
      await ctx.openTeam({ fixture: 'borrow', viewer: 'viewer:readonly' });
      await ctx.openPage('now');
      const needs = (await ctx.text('[data-page=now]')) ?? '';
      const escalationButtons = await ctx.count('[data-escalation-action]');
      const pass = badge === '只读' && writes.length === 0 && actions !== null && actions.includes('只读查看')
        && toast === '只读查看 · 无写权限' && needs.includes('有 1 件事在等组长决定') && escalationButtons === 0;
      return {
        pass,
        measured: { badge, buttons, writes, actions, toast, needs: needs.slice(0, 120), escalationButtons },
        detail: pass
          ? '徽标「只读」；0 个写按钮；右栏为说明块；按 a 提示「只读查看 · 无写权限」；升级区只报数量且无按钮'
          : '只读态不符：' + JSON.stringify({ badge, writes, actions, toast, escalation: needs.slice(0, 80), escalationButtons }),
        note: '15 §9 的文案是「只读查看 · 无写权限」徽标 + 页顶横幅；v3 §4 只保留标题行「只读」徽标并去掉横幅，'
          + '该文案改为按 a 的身份说明，本条按 v3 判定。',
      };
    },
  },
  {
    id: 'V-13',
    section: '禁用、查看、只读',
    title: '受限成员只以人数出现，DOM 里没有他们的名字',
    async run(ctx) {
      await ctx.page.setViewport(1440, 900);
      await ctx.openTeam({ fixture: 'default' });
      const roster = await ctx.text('.tm-roster');
      const restrictedLine = (roster ?? '').split('\n').find(line => line.includes('受限成员')) ?? null;
      await ctx.openPage('members');
      const rows = await ctx.count('[data-page=members] [data-member]');
      const body = await ctx.evaluate('document.body.innerText');
      const restrictedCount = restrictedLine ? Number(restrictedLine.match(/×\s*([0-9]+)/)?.[1] ?? NaN) : NaN;
      const named = /受限成员[^\n]*[：:][^\n]+/.test(roster ?? '');
      const pass = restrictedCount === 2 && !named && rows === 17 && !/受限/.test(await ctx.text('[data-page=members]') ?? '');
      return { pass, measured: { restrictedLine, restrictedCount, rows, named },
        detail: pass ? '花名册底部「受限成员 ×2」，成员表 17 行，页面无受限成员姓名'
          : '受限成员呈现不符：' + JSON.stringify({ restrictedLine, rows, named, bodyLength: body.length }),
        note: 'mock 模式下投影在浏览器内生成，没有网络响应可查；「响应里没有名字」由 projections 的 ACL 用例覆盖。' };
    },
  },
];
