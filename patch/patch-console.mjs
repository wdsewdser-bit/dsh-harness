import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import vm from 'node:vm'

const roots = [
  'D:\\dsh-test\\home\\profiles\\web\\node_modules\\@deepseek-ai\\dsh-experimental-client-ui-agent-team',
  'D:\\dsh-test\\home\\profiles\\node_modules\\@deepseek-ai\\dsh-experimental-client-ui-agent-team'
]
const packageRoot = roots.find((root) => existsSync(root + '\\package.json'))
if (packageRoot === undefined) throw new Error('client-ui-agent-team package not found')
const packageJson = JSON.parse(readFileSync(packageRoot + '\\package.json', 'utf8'))
if (packageJson.version !== '0.1.6-alpha.1') throw new Error(`unsupported client-ui-agent-team version: ${packageJson.version}`)
const target = packageRoot + '\\lib\\client.js'
const backup = target + '.orig'
const marker = '/* dsh-test patch-console 0.1.6-alpha.1 v2 */'
if (readFileSync(target, 'utf8').includes(marker)) {
  console.log('already patched: ' + target)
  process.exit(0)
}
if (!existsSync(backup)) copyFileSync(target, backup)
let src = readFileSync(backup, 'utf8')
src = marker + '\n' + src
const helpers = readFileSync('D:\\dsh-test\\patch\\roster-helpers.js', 'utf8')

const steps = []
const fail = (label, detail) => { steps.push('FAIL ' + label + (detail ? ' -- ' + detail : '')); throw new Error(label + (detail ? ': ' + detail : '')) }
const insertAfter = (label, anchor, text, from = 0) => {
  const i = src.indexOf(anchor, from)
  if (i < 0) fail(label, 'anchor not found')
  src = src.slice(0, i + anchor.length) + text + src.slice(i + anchor.length)
  steps.push('ok   ' + label)
}
const insertBefore = (label, anchor, text, from = 0) => {
  const i = src.indexOf(anchor, from)
  if (i < 0) fail(label, 'anchor not found')
  src = src.slice(0, i) + text + src.slice(i)
  steps.push('ok   ' + label)
}

// A. let registerUi reach the operator command channel
{
  const call = src.indexOf('], registerUi);')
  if (call < 0) fail('A inject list', 'call site not found')
  // The dependency array ends with "locale" and no trailing comma; append the new
  // dependency to that last element rather than trying to insert before the ']'.
  const last = src.lastIndexOf('"locale"', call)
  if (last < 0) fail('A inject list', 'locale dependency not found')
  const after = last + '"locale"'.length
  src = src.slice(0, after) + ',\n\t\t\t\t"remote.commands"' + src.slice(after)
  steps.push('ok   A inject remote.commands')
}

// C. TeamAction takes the metadata
{
  const from = 'function TeamAction({ sessionId, load, createTask, updateTask, openTeammate, t }) {'
  const to = 'function TeamAction({ sessionId, load, createTask, updateTask, openTeammate, meta, t }) {'
  if (!src.includes(from)) fail('C signature', 'not found')
  src = src.replace(from, to)
  steps.push('ok   C TeamAction signature')
}

// D. metadata state
insertAfter('D teamMeta state', 'const [view, setView] = (0, react.useState)(null);',
  '\n\t\t\tconst [teamMeta, setTeamMeta] = (0, react.useState)(null);')

// E. clear it when the session changes
insertAfter('E reset teamMeta', 'setView(null);', '\n\t\t\t\tsetTeamMeta(null);')

// F. fetch it with the view
insertAfter('F fetch teamMeta', 'setView(result.value);',
  '\n\t\t\t\tvoid Promise.resolve(meta === void 0 ? null : meta(requestedSession)).then((value) => {\n' +
  '\t\t\t\t\tif (sessionRef.current === requestedSession) setTeamMeta(value);\n' +
  '\t\t\t\t}).catch(() => {});')

// B. the meta() action behind /team meta. Member identity no longer comes from here —
// the forked domain carries level/groupId/frozen on the roster row — but the level and
// group BOARDS still live in the policy layer, so the panel keeps fetching them.
insertBefore('B meta action',
  '\t\t\t\tasync openTeammate(sessionId, member) {',
  '\t\t\t\tasync meta(sessionId) {\n' +
  '\t\t\t\t\ttry {\n' +
  '\t\t\t\t\t\tconst result = await ctx.remote.commands.execute(leadSessionId(sessionId), "/team meta", []);\n' +
  '\t\t\t\t\t\tif (!result || result.ok === false) return null;\n' +
  '\t\t\t\t\t\tconst payload = result.value && result.value.result;\n' +
  '\t\t\t\t\t\tif (!payload || typeof payload.text !== "string") return null;\n' +
  '\t\t\t\t\t\treturn JSON.parse(payload.text);\n' +
  '\t\t\t\t\t} catch (error) {\n' +
  '\t\t\t\t\t\treturn null;\n' +
  '\t\t\t\t\t}\n' +
  '\t\t\t\t},\n')

// G. replace the flat member map with the grouped renderer
{
  const start = src.indexOf('children: view.members.map((member) =>')
  if (start < 0) fail('G member block', 'start not found')
  const endMarker = '}, member.id))'
  const end = src.indexOf(endMarker, start)
  if (end < 0) fail('G member block', 'end not found')
  const replacement = 'children: (0, react_jsx_runtime.jsx)(RosterView, { members: view.members, meta: teamMeta, sessionId, openTeammate, setError, t, css: TeamAction_module_css_default, StateDot: _deepseek_ai_dsh_client_ui_primitives.StateDot })'
  src = src.slice(0, start) + replacement + src.slice(end + endMarker.length)
  steps.push('ok   G grouped roster')
}

// H. the helpers themselves
insertBefore('H helper block', '\t\tfunction TeamAction(', helpers)

// I/J. dictionary keys
insertAfter('I zh keys', '\t\t\tmodel: "模型",',
  '\n\t\t\ttier: "级别",\n\t\t\tgroup: "分组",\n\t\t\tfrozen: "已冻结",\n\t\t\ttierUnknown: "未登记级别",\n\t\t\tboards: "看板",\n\t\t\tglobalBoard: "全局板",\n\t\t\tlevelBoard: "层看板",\n\t\t\tgroupBoard: "组看板",\n\t\t\tboardEmpty: "该看板还没有任务",\n\t\t\troleLead: "主控",\n\t\t\troleGroupLead: "组长",\n\t\t\troleMember: "组员",\n\t\t\troleVerifier: "审查员",\n\t\t\troleCustom: "自定义",\n\t\t\tfiltering: "筛选中",\n\t\t\tclearFilter: "显示全部",\n\t\t\tfilterHint: "点击按该级别与分组筛选",\n\t\t\thintToggle: "点击展开/收起",\n\t\t\thintCollapse: "点击收起任务",\n\t\t\thintExpand: "点击展开任务",\n\t\t\t"memberStatus.frozen": "已冻结",')
insertAfter('J en keys', '\t\t\tmodel: "Model",',
  '\n\t\t\ttier: "Level",\n\t\t\tgroup: "Group",\n\t\t\tfrozen: "Frozen",\n\t\t\ttierUnknown: "Unregistered",\n\t\t\tboards: "Boards",\n\t\t\tglobalBoard: "Global board",\n\t\t\tlevelBoard: "level board",\n\t\t\tgroupBoard: "group board",\n\t\t\tboardEmpty: "No tasks on this board",\n\t\t\troleLead: "Lead",\n\t\t\troleGroupLead: "Group lead",\n\t\t\troleMember: "Member",\n\t\t\troleVerifier: "Verifier",\n\t\t\troleCustom: "Custom",\n\t\t\tfiltering: "Filtering",\n\t\t\tclearFilter: "Show all",\n\t\t\tfilterHint: "Click to filter by this level and group",\n\t\t\thintToggle: "Click to expand or collapse",\n\t\t\thintCollapse: "Click to collapse tasks",\n\t\t\thintExpand: "Click to expand tasks",\n\t\t\t"memberStatus.frozen": "Frozen",')
insertAfter('I2 zh room keys', '\t\t\t"memberStatus.frozen": "已冻结",',
  '\n\t\t\trooms: "协作房间",\n\t\t\troomIdle: "空闲",\n\t\t\thost: "主持人",\n\t\t\tround: "轮次",\n\t\t\tnextSpeaker: "下一位发言",\n\t\t\tpendingEscalations: "待决升级",\n\t\t\tdispatches: "消息投递",\n\t\t\tqueueAge: "排队",\n\t\t\tattempt: "第 N 次",')
insertAfter('J2 en room keys', '\t\t\t"memberStatus.frozen": "Frozen",',
  '\n\t\t\trooms: "Rooms",\n\t\t\troomIdle: "Idle",\n\t\t\thost: "Host",\n\t\t\tround: "Round",\n\t\t\tnextSpeaker: "Next speaker",\n\t\t\tpendingEscalations: "Pending escalations",\n\t\t\tdispatches: "Dispatches",\n\t\t\tqueueAge: "Queue age",\n\t\t\tattempt: "attempt",')

// Compile before writing: a broken bundle would take the whole header seat down.
new vm.Script(src, { filename: 'client.js' })
writeFileSync(target, src)
console.log(steps.join('\n'))
console.log('written bytes=' + src.length + ' compiled=ok')
