import {
  compactRoomSnapshot,
  roomAdmissionVerdict,
  roomKindVerdict,
} from '../home/profiles/web/plugins/team-tools-v2.mjs'

let failed = 0
const check = (label, condition, detail) => {
  if (!condition) failed += 1
  console.log((condition ? 'PASS ' : 'FAIL ') + label + (detail ? '  ' + detail : ''))
}

const lead = { name: 'lead', tier: 0, group: 'root', parent: null }
const groupLead = { name: 'alpha-lead', tier: 1, group: 'alpha', parent: 'lead' }
const member = { name: 'alpha-1', tier: 2, group: 'alpha', parent: 'alpha-lead' }
const otherLead = { name: 'beta-lead', tier: 1, group: 'beta', parent: 'lead' }

check('valid group room id', roomKindVerdict('group:alpha:tier-2', 'group').ok === true)
check('malformed group room id is refused', roomKindVerdict('group:alpha', 'group').ok === false)
check('level room id is fixed', roomKindVerdict('level:1', 'level').ok === true
  && roomKindVerdict('level:2', 'level').ok === false)

const groupRoom = { roomId: 'group:alpha:tier-2', kind: 'group', members: [groupLead.name, member.name] }
check('group lead is admitted to its own group room',
  roomAdmissionVerdict(groupRoom, groupLead, groupLead).ok === true)
check('group member is admitted to its own group room',
  roomAdmissionVerdict(groupRoom, groupLead, member).ok === true)
check('other group cannot be admitted to a group room',
  roomAdmissionVerdict(groupRoom, groupLead, otherLead).ok === false)

const levelRoom = { roomId: 'level:1', kind: 'level', members: ['lead', groupLead.name, otherLead.name] }
check('tier-1 peer is admitted to level room',
  roomAdmissionVerdict(levelRoom, groupLead, otherLead).ok === true)
check('tier-2 member is refused from level room',
  roomAdmissionVerdict(levelRoom, groupLead, member).ok === false)

const rootRoom = { roomId: 'root', kind: 'root', members: ['lead', groupLead.name] }
check('root room admits the tier-0 lead',
  roomAdmissionVerdict(rootRoom, groupLead, lead).ok === true)
check('root room admits a tier-1 lead',
  roomAdmissionVerdict(rootRoom, groupLead, groupLead).ok === true)
check('root room refuses a tier-2 member',
  roomAdmissionVerdict(rootRoom, groupLead, member).ok === false)

const taskRoom = { roomId: 'task:ship', kind: 'task', members: [groupLead.name, member.name] }
check('task room admits the owning lead and its member',
  roomAdmissionVerdict(taskRoom, groupLead, member).ok === true)
check('task room refuses an unrelated lead',
  roomAdmissionVerdict(taskRoom, groupLead, otherLead).ok === false)

const snapshot = compactRoomSnapshot({
  rooms: {
    'task:ship': {
      roomId: 'task:ship',
      kind: 'task',
      status: 'open',
      host: groupLead.name,
      members: [groupLead.name, member.name],
      currentRoundId: 'round-1',
      summary: 'interface draft',
      revision: 3,
      decisions: [{ decisionId: 'd1', title: 'api', choice: 'v1' }],
      messages: [
        { kind: 'risk', author: member.name, content: 'race', references: ['test-output'] },
        { kind: 'fact', author: groupLead.name, content: 'ok', references: ['commit-1'] },
      ],
    },
  },
  rounds: {
    'round-1': {
      roundId: 'round-1',
      roomId: 'task:ship',
      topic: 'interface',
      status: 'open',
      nextSpeaker: member.name,
      mainSpoken: [groupLead.name],
      clarified: [],
      order: [groupLead.name, member.name],
    },
  },
  escalations: {},
}, 'task:ship', member.name)

check('compact snapshot exposes next speaker and turn progress',
  snapshot.round.nextSpeaker === member.name && snapshot.round.spoken[0] === groupLead.name)
check('compact snapshot tells the current speaker to speak',
  snapshot.waitAction === 'speak' && /Post one main speech/.test(snapshot.waitInstruction))
check('compact snapshot classifies unresolved risks and evidence',
  snapshot.unresolved.length === 1 && snapshot.conflicts.length === 1
    && snapshot.evidence.includes('test-output'))
check('compact snapshot does not replay the raw transcript',
  snapshot.rawMessages === undefined && snapshot.messages === undefined)

console.log('checks=all failed=' + failed)
process.exit(failed === 0 ? 0 : 1)
