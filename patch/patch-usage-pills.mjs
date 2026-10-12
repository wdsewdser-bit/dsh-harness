/** Patch the shadowed ui-chat client: two extra composer pills for whole-Team usage. */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const vm = require('node:vm')

const roots = [
  'D:\\dsh-test\\home\\profiles\\web\\node_modules\\@deepseek-ai\\dsh-client-ui-chat',
  'D:\\dsh-test\\home\\profiles\\node_modules\\@deepseek-ai\\dsh-client-ui-chat',
  'D:\\dsh-test\\app\\node_modules\\@deepseek-ai\\dsh-client-ui-chat'
]
const packageRoot = roots.find((root) => existsSync(root + '\\package.json'))
if (packageRoot === undefined) fail('package', 'dsh-client-ui-chat not found')
const pkg = JSON.parse(readFileSync(packageRoot + '\\package.json', 'utf8'))
if (pkg.version !== '0.1.6-alpha.1') fail('version', 'expected 0.1.6-alpha.1, got ' + pkg.version)
const TARGET = packageRoot + '\\lib\\client.js'
const ORIG = TARGET + '.orig'
const MARKER = '/* dsh-test patch-usage-pills 0.1.6-alpha.1 */'
const fail = (tag, why) => { console.error('FAIL ' + tag + ': ' + why); process.exit(1) }
if (readFileSync(TARGET, 'utf8').includes(MARKER)) {
  console.log('already patched: ' + TARGET)
  process.exit(0)
}
if (!existsSync(ORIG)) copyFileSync(TARGET, ORIG)
let src = readFileSync(ORIG, 'utf8')
src = MARKER + '\n' + src
const steps = []
const cut = (text, marker) => { if (!text.includes(marker)) fail('anchor', marker.slice(0, 40)); return text }

// Short, tab-free anchors: the generated file is minified-ish, so indentation is not
// something a patch should ever depend on.
const A = 'function UsagePill({ usage, t, dialog }) {'
const B = 'const usage = useProjection("tokenUsage");'
const C = 'openPill === "usage",'
cut(src, A); cut(src, B); cut(src, C)

const lines = []
const add = (...parts) => { for (const part of parts) lines.push(part) }
add(
  '/** Whole-Team totals: every agent plus the Lead, not just this session. */',
  'function TeamTotalPill({ usage, lead, t }) {',
  // Each line is its own array element. Putting comments and code in ONE string joined by
  // \n does not work here: the escape lands in the file literally, so the // swallows the
  // code after it. That is exactly how `const all` vanished and crashed the whole pill row.
  '  const all = lead + usage.otherTotal;',
  '  const totalText = t("message.turnUsage.count", { count: formatTokens(all, t) });',
  '  const hit = all > 0 ? formatCacheHitPercent(usage.cached, all) : null;',
  '  const label = "ALL " + usage.agents + " / " + totalText + (hit === null ? "" : " / " + hit + "%");',
  '  return (0, react_jsx_runtime.jsx)("span", { className: StatsPills_module_css_default.anchor, children: (0, react_jsx_runtime.jsxs)("button", { type: "button", className: StatsPills_module_css_default.pill, "data-team-usage": "all", title: label, "aria-label": label, children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDatabaseOutline16, {}), (0, react_jsx_runtime.jsx)("span", { className: StatsPills_module_css_default.label, children: label })] }) });',
  '}',
  '/** What the sub-agents burned: the part the Lead-only pill hides. */',
  'function TeamOthersPill({ usage, t }) {',
  '  const share = usage.total > 0 ? Math.round((usage.otherTotal / usage.total) * 100) : 0;',
  '  const label = "OTHERS " + share + "% / " + t("message.turnUsage.count", { count: formatTokens(usage.otherTotal, t) });',
  '  return (0, react_jsx_runtime.jsx)("span", { className: StatsPills_module_css_default.anchor, children: (0, react_jsx_runtime.jsxs)("button", { type: "button", className: StatsPills_module_css_default.pill, "data-team-usage": "others", title: label, "aria-label": label, children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconDatabaseOutline16, {}), (0, react_jsx_runtime.jsx)("span", { className: StatsPills_module_css_default.label, children: label })] }) });',
  '}',
)
src = src.replace(A, lines.join('\n') + '\n' + A)
steps.push('ok   A two pill components')

src = src.replace(B, B + ' const teamUsage = useProjection("teamUsage");')
steps.push('ok   B teamUsage projection read')

// Keep the existing `})` and the closing `]`, and add the two pills between them, so the
// children array keeps its shape and the new pills land to the right of the old ones.
const shown = 'teamUsage === null || teamUsage === undefined ? null : (0, react_jsx_runtime.jsx)'
const leadLive = 'billedInputTokens(usage) + usage.outputTokens'
const guarded = '(usage === null || usage === undefined ? 0 : ' + leadLive + ')'
const render = ', ' + shown + '(TeamTotalPill, { usage: teamUsage, lead: ' + guarded + ', t }), ' + shown + '(TeamOthersPill, { usage: teamUsage, t })'
const CLOSE = '})]'
const at = src.indexOf(C)
if (at < 0) fail('C', 'no usage-pill anchor')
const tail = src.indexOf(CLOSE, at)
if (tail < 0) fail('C close', 'no closing bracket after sessionStats')
src = src.slice(0, tail) + '})' + render + ']' + src.slice(tail + CLOSE.length)
steps.push('ok   C two pills rendered')

try { new vm.Script(src) } catch (error) { fail('compile', String(error && error.message)) }
steps.push('ok   compiled')
writeFileSync(TARGET, src)
console.log(steps.join('\n'))
console.log('written bytes=' + Buffer.byteLength(src))
