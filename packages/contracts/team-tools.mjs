import { fail, failWith, operationIdSource } from './index.mjs';
import {deadlineSchema} from './deadline.mjs';

const string = { type: 'string', minLength: 1 };

/** Published ref shapes so the model never has to guess an id prefix; 08 §4.10. */
export const readRefHint = 'Omit ref to list the whole view. For view "team" ref may also be "team" or omitted. ' +
  'Every other view takes the full id exactly as it appears in the snapshot or a tool result: ' +
  'task "task:real:1:a1", thread "thread:v1:issue:<uuid>", message "message:v1:message:<uuid>", ' +
  'member "member:a1", evidence "artifact:1:a1". A bare suffix such as "1:a1" is resolved inside the view ' +
  '(in the evidence view that means "artifact:1:a1" or "verification-evidence:1:a1").';

/** Published operation identity rule: any unique readable id, not only hex; 08 §2.2. */
const operationIdHint = 'Unique retry id matching v1:operation:<8-128 characters of A-Za-z0-9._->, ' +
  'for example v1:operation:cycle1-a1-send-0001. Repeating the same id with the same arguments replays the receipt; ' +
  'a new intent needs a new id.';

const revision = { type: 'integer', minimum: 0 };
/**
 * Where a revision expectation is worth requiring, and where it is not.
 *
 * expectedRevision guards a read-then-write against a row that moved. On a branch that creates a new row there is no
 * row to name, and on a branch that acts on the caller's own task or on an independent verdict the ownership and
 * independence guards already do the work: requiring a number the model cannot read (the snapshot publishes the
 * contract revision, not the row revision) only produced refusals in the second real collaboration run -- six of the
 * nine branch errors were a send with no expectedRevision. Those branches accept its omission; a stale value is still
 * a CAS refusal, so nothing is loosened for a caller that does send one.
 */
const omittableExpectedRevision = {'team_message': ['send'], 'team_thread': ['open'], 'team_plan': ['create'],
  'team_task': ['produce', 'checkpoint'], 'team_verify': ['*'], 'team_decision': ['*'], 'team_assume': ['*'],
  // P2: provision/group create a new row (or move a member by id), so there is no revision the model could have read.
  'team_decide': ['*'], 'team_member': ['provision', 'group']};
const expectedRevisionHint = 'The row revision this call writes. It may be omitted on a call that creates a new row ' +
  '(team_message send, team_thread open, team_plan create), on your own team_task produce/checkpoint, and on team_verify, ' +
  'team_decision and team_assume, where ownership, independence and the operation id are the guard instead; when it is ' +
  'sent it is still checked.';
const strings = { type: 'array', items: string };
const enumeration = values => ({ enum: values.split('|') });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const write = properties => object({ operationId: string, expectedRevision: revision, ...properties });
const branch = (op, properties) => write({ op: { const: op }, ...properties });
/** P2: a branch whose extra fields may be omitted -- a published surface must not demand a group nobody has to name. */
const withOptional = (schema, keys) => ({ ...schema, required: schema.required.filter(key => !keys.includes(key)) });

/**
 * P2 §4.2.2: the two fields root assigns.
 *
 * A group is one token, so it can never look like a path or an entity id. A workspace is a path RELATIVE to the team
 * root: the published pattern already refuses absolute paths, drive letters, backslashes (and therefore UNC) and any
 * ".."; the host resolves the rest with realpath and refuses anything that lands outside the team root.
 */
const groupField = { ...string, maxLength: 64,
  description: 'Group the member joins (omitted: "default"). One token of A-Z a-z 0-9 . _ -, assigned by root; anything else is INVALID_GROUP.' };
// The path rule is stated once, in the reducer that owns it, so the refusal carries the code the design names
// (INVALID_WORKSPACE) instead of a shape complaint: absolute paths, drive letters, UNC paths, backslashes and ".." all
// reach the reducer and are refused there, and the host refuses anything whose realpath is outside the team root.
const workspaceField = { ...string, maxLength: 200,
  description: 'Workspace path RELATIVE to the team root, e.g. work/w1. Absolute paths, drive letters, UNC paths, backslashes and ".." are refused with INVALID_WORKSPACE, and the host refuses any path whose realpath lands outside the team root.' };
const assigneeField = { ...string, maxLength: 128, pattern: '^member:[A-Za-z0-9:._-]+$' };

/** Publish closed role tool schemas without caller-supplied authority; 08 §4.10. */
export const teamSchemas = {
  team_read: object({ view: { ...enumeration('team|task|member|thread|message|evidence'),
    description: 'team = current member roster; task|member|thread|message|evidence = one typed collection.' },
  ref: { ...string, maxLength: 256, description: readRefHint },
  afterSeq: revision, limit: { type: 'integer', minimum: 1, maximum: 50, description: 'default 20, maximum 50' } }, ['view']),
  team_message: { oneOf: [
    object({ operationId: string, expectedRevision: revision, op: { const: 'send' }, to: string,
      kind: enumeration('info|action|decision'), summary: { ...string, maxLength: 1024 },
      taskRef: string, threadRef: string, bodyRef: string, expectedOutcome: string, deadline: deadlineSchema },
      ['operationId', 'expectedRevision', 'op', 'to', 'kind', 'summary']),
    branch('accept', { messageId: string, checkpointRef: string }),
    branch('resolve', { messageId: string, resultRef: string }),
  ] },
  team_thread: { oneOf: [branch('open', { question: string, owner: string, requiredRespondents: strings, requiredEvidence: strings, deadline: deadlineSchema, taskRef: string }),
    branch('reply', { issueId: string, proposalRevision: revision, bodyRef: string }),
    branch('decide', { issueId: string, proposalRevision: revision, conclusionRef: string })] },
  team_wait: write({ dependency: { oneOf: [
    object({ kind: { const: 'Approval' }, planId: string, revision }),
    object({ kind: { const: 'TaskAccepted' }, taskId: string, deliveryRevision: revision }),
    object({ kind: { const: 'ArtifactPublished' }, ref: string, hash: { ...string, pattern: '^[a-f0-9]{64}$' } }),
    object({ kind: { const: 'MessageResponsibility' }, messageId: string, recipientGeneration: revision }),
    object({ kind: { const: 'Decision' }, issueId: string, proposalRevision: revision }),
    object({ kind: { const: 'ExternalEvidence' }, owner: string, deadline: deadlineSchema, ref: string }),
  ] }, deadline: deadlineSchema, reason: { ...string, maxLength: 512 } }),
  team_plan: { oneOf: [object({ operationId: string, expectedRevision: revision, op: { const: 'create' },
    requirementRef: string, parentTaskRef: string, owner: string, scopeSet: strings, delegationRef: string,
    deliveryKind: enumeration('code|evidence'), acceptanceRef: string },
    ['operationId', 'expectedRevision', 'op', 'requirementRef', 'owner', 'scopeSet', 'deliveryKind', 'acceptanceRef']),
    object({ operationId: string, expectedRevision: revision, op: { const: 'approve' }, taskRef: string,
      contractRevision: revision, delegationRef: string }, ['operationId', 'expectedRevision', 'op', 'taskRef', 'contractRevision'])] },
  // §4.2.1 / §10 P0: the DEFAULT surface is HEAD's, branch for branch. The two branches P2 added (provision, group) and
  // the group field on request are published only while the autonomy switch is on (autonomySchemas below), so a team that
  // never switched the package on registers the tool catalog -- and the catalog hash -- it registered before it existed.
  team_member: { oneOf: [branch('request', { role: enumeration('subCoordinator|worker|verifier'), subgoalRef: string, reason: string }),
    branch('freeze', { memberRef: string, reason: string }), branch('resume', { memberRef: string, reason: string }), branch('retire', { memberRef: string, reason: string })] },
  team_task: { oneOf: [branch('checkpoint', { taskRef: string, progressRef: string }), branch('produce', { taskRef: string, deliveryRef: string })] },
  team_verify: write({ deliveryRef: string, contractRevision: revision, verdict: enumeration('pass|fail'), evidenceRefs: strings, reason: string }),
  team_goal: { oneOf: [branch('inspect', { goalRef: string }), branch('requestCompletion', { goalRef: string })] },
};

// Apply typed identity constraints recursively, including dependency unions.
const annotate = (schema, options = {}) => {
  for (const branch of schema.oneOf ?? []) annotate(branch, options);
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    const prefix = { messageId: 'message', issueId: 'thread', taskId: 'task', taskRef: 'task',
      to: 'member', owner: 'member', memberRef: 'member' }[key];
    if (prefix) schema.properties[key] = { ...value, pattern: '^' + prefix + ':[A-Za-z0-9:._-]+$' };
    else if (key === 'operationId') {
      schema.properties[key] = { ...value, maxLength: 128, pattern: operationIdSource, description: operationIdHint };
    } else if (key === 'ref' && options.bareRef) {
      // team_read resolves the ref server-side against the chosen view, so a bare suffix is publishable.
    } else if (/Ref$|Id$/.test(key) || key === 'ref') {
      schema.properties[key] = { ...value, pattern: '^(v1:[a-z-]+:|[a-z-]+:)[A-Za-z0-9:._-]+$' };
    }
    if (key === 'evidenceRefs' || key === 'requiredRespondents' || key === 'requiredEvidence') {
      schema.properties[key] = { ...value, items: { ...string, pattern: key === 'requiredRespondents' ? '^member:[A-Za-z0-9:._-]+$' : '^(v1:[a-z-]+:|[a-z-]+:)[A-Za-z0-9:._-]+$' } };
    }
    annotate(value, options);
  }
};
Object.entries(teamSchemas).forEach(([name, schema]) => annotate(schema, { bareRef: name === 'team_read' }));

/**
 * Publish expectedRevision as optional exactly where tool-reducer.mjs treats its absence as "the value I read", and
 * publish the sentence that says so next to the field everywhere else.
 *
 * This runs after annotate() so the pattern/maxLength rules stay in one place. A branch that is not listed keeps the
 * field required, so accept/resolve/decide/approve stay strict CAS calls.
 */
function relaxExpectedRevision(schema, name) {
  const ops = omittableExpectedRevision[name];
  if (!ops) return;
  const relax = entry => {
    entry.required = (entry.required ?? []).filter(key => key !== 'expectedRevision');
    if (entry.properties?.expectedRevision) entry.properties.expectedRevision = { ...entry.properties.expectedRevision, description: expectedRevisionHint };
  };
  // A schema with no operation branch (team_verify) is a single call: '*' applies to it as a whole.
  if (!schema.oneOf && ops.includes('*')) return relax(schema);
  for (const entry of schema.oneOf ?? []) {
    const op = entry.properties?.op?.const;
    if (!op || !(ops.includes('*') || ops.includes(op))) continue;
    relax(entry);
  }
}
Object.entries(teamSchemas).forEach(([name, schema]) => relaxExpectedRevision(schema, name));

const shown = value => typeof value === 'string' ? JSON.stringify(value.length > 64 ? value.slice(0, 64) + '…' : value)
  // An object is echoed by its field names: a refusal that repeats a whole 2 KB payload buries the sentence that says
  // what to fix, and the caller already knows what it sent.
  : Array.isArray(value) ? '[' + value.length + ' items]'
  : value && typeof value === 'object' ? '{' + Object.keys(value).join(',') + '}'
  : JSON.stringify(value) ?? String(value);
const branchSummary = schema => (schema.oneOf ?? []).map(branch =>
  Object.entries(branch.properties ?? {}).map(([key, entry]) => key === 'op' ? entry.const : key).join('+')).join(' | ');
const hint = (entry, path) => {
  if (entry.enum) return path + ' must be one of ' + entry.enum.join(', ');
  if (typeof entry.pattern === 'string') return path + ' must match ' + entry.pattern;
  if (entry.description) return entry.description;
  return '';
};

/** Validate the published schema subset server-side and name the exact field to repair; 08 §4.10. */
export function validateTool(schema, value, path = '$') {
  if (schema.oneOf) {
    // The branch that came closest is what names the repair. A call can satisfy every branch but one field length and
    // still be answered with "unknown operation branch", which sends the caller looking for a branch problem it does
    // not have (the first real collaboration run lost two turns to exactly that). So each branch's refusal is kept, and
    // the one with the fewest complaints is reported with its own field diagnosis.
    const refusals = schema.oneOf.map(branch => { try { validateTool(branch, value); return null; } catch (error) { return error; } });
    const matches = refusals.filter(error => error === null).length;
    if (matches !== 1) {
      // How far the branch was from accepting: a wrong branch rejects every field it does not publish, the branch the
      // caller meant rejects one value. The smallest complaint count is therefore the branch to quote.
      const trouble = error => {
        const detail = String(error.detail ?? error.message);
        if (error.code !== 'INVALID_TOOL_FIELDS') return 1;
        const counted = [...detail.matchAll(/(?:unknown|missing) field\(s\) ([^;]+)/g)]
          .reduce((n, match) => n + match[1].split(',').length, 0);
        return counted || 1;
      };
      const best = refusals.filter(Boolean).map(error => ({ error, score: trouble(error) }))
        .sort((a, b) => a.score - b.score)[0];
      failWith('INVALID_TOOL_BRANCH', 'unknown operation branch; the closest branch was refused with ' +
        (best ? (best.error.detail ?? best.error.message) : 'nothing') + '; publishable branches are ' + branchSummary(schema) +
        ' (got ' + shown(value) + ')');
    }
    return value;
  }
  if (schema.const !== undefined && value !== schema.const) {
    failWith('INVALID_CONST', path + ' must be ' + shown(schema.const) + ' (got ' + shown(value) + ')');
  }
  if (schema.enum && !schema.enum.includes(value)) {
    failWith('INVALID_ENUM', path + ' must be one of ' + schema.enum.join(', ') + ' (got ' + shown(value) + ')');
  }
  if (schema.type === 'object') {
    const unknown = value && typeof value === 'object' && !Array.isArray(value)
      ? Object.keys(value).filter(key => !Object.hasOwn(schema.properties, key)) : [];
    const missing = !value || typeof value !== 'object' || Array.isArray(value) ? schema.required
      : schema.required.filter(key => !Object.hasOwn(value, key));
    if (unknown.length || missing.length) failWith('INVALID_TOOL_FIELDS',
      (unknown.length ? 'unknown field(s) ' + unknown.join(', ') + '; ' : '') +
      (missing.length ? 'missing field(s) ' + missing.join(', ') + '; ' : '') +
      'publishable field(s) ' + Object.keys(schema.properties).join(', '));
    for (const [key, entry] of Object.entries(value)) validateTool(schema.properties[key], entry, path === '$' ? key : path + '.' + key);
  }
  if (schema.type === 'string' && (typeof value !== 'string' || value.length < (schema.minLength ?? 0) ||
    value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) {
    // A length refusal has to say the limit and the actual length: "not a publishable string" plus a truncation of the
    // value reads like a content problem, and a caller then rewords a sentence that only needed to be shorter.
    const length = typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength
      ? path + ' is ' + value.length + ' characters and the published limit is ' + schema.maxLength
      : null;
    // A length refusal is the whole diagnosis: repeating "not a publishable string" around it only pushes the limit
    // further away from the caller's eye.
    if (length) failWith('INVALID_STRING', length + ' (got ' + shown(value) + ')');
    failWith('INVALID_STRING', path + ' is not a publishable string (got ' + shown(value) + '); ' +
      (typeof value !== 'string' ? 'expected a string' : hint(schema, path)));
  }
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? 0) || value > (schema.maximum ?? Infinity))) {
    failWith('INVALID_INTEGER', path + ' must be an integer between ' + (schema.minimum ?? 0) + ' and ' +
      (schema.maximum ?? Number.MAX_SAFE_INTEGER) + ' (got ' + shown(value) + ')');
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) failWith('INVALID_ARRAY', path + ' must be an array (got ' + shown(value) + ')');
    value.forEach((entry, index) => validateTool(schema.items, entry, path + '[' + index + ']'));
  }
  if (schema.type === 'object') {
    const prefixes = { messageId: 'message:', issueId: 'thread:', taskRef: 'task:', to: 'member:', owner: 'member:', memberRef: 'member:' };
    for (const [key, prefix] of Object.entries(prefixes)) {
      // A recipient set (intent) is an array; its members carry the published pattern instead.
      if (typeof value[key] === 'string' && !value[key].startsWith(prefix)) {
        failWith('INVALID_ID', path + '.' + key + ' must start with "' + prefix + '" (got ' + shown(value[key]) + ')');
      }
    }
  }
  return value;
}

/**
 * The two collaboration-only tools. They live outside `teamSchemas` on purpose: that object is the published
 * default surface, and `teamSchemasFor('off')` must return it by identity so the tool-catalog hash of the default
 * profile cannot move when this experiment is merged. 08 §4.10, 11 §2.
 */
export const collabSchemas = {
  /**
   * A formal assumption, not a message: raising one delivers it to the member the assumption is about and does
   * not block the raiser; the owner answers it at its next boundary with confirm or correct.
   */
  team_assume: { oneOf: [
    object({ operationId: string, expectedRevision: revision, about: { ...string, maxLength: 128,
      description: 'member:<id> the assumption is about, or artifact:<cycle>:<actor> / task:<id> whose owner must confirm it.' },
      claim: { ...string, maxLength: 512, description: 'What you are assuming to be true about that owner or artifact.' },
      impact: { ...string, maxLength: 512, description: 'What breaks in your own work if the claim is wrong.' },
      deadline: deadlineSchema },
      ['operationId', 'expectedRevision', 'about', 'claim', 'impact']),
    object({ operationId: string, expectedRevision: revision, assumptionId: string,
      verdict: enumeration('confirm|correct'),
      correction: { ...string, maxLength: 1024,
        description: 'Required with verdict correct: what the truth is instead, at most 1024 characters (the same prose limit as a message summary). Put anything longer in a follow-up info message.' } },
      ['operationId', 'expectedRevision', 'assumptionId', 'verdict']),
  ] },
  /** A decision log entry: ledger only, no message, no wake, no responsibility. */
  team_decision: object({ operationId: string, expectedRevision: revision,
    summary: { ...string, maxLength: 512,
      description: 'Short statement of the decision you just made: one paragraph, at most 512 characters. Put the contract itself in the message or the artifact it governs, not here.' },
    affects: { type: 'array', maxItems: 8, items: { ...string, maxLength: 128 },
      description: 'Optional member:<id>, task:<id> or artifact:<cycle>:<actor> this decision affects; used to filter whose snapshot carries it.' } },
    ['operationId', 'expectedRevision', 'summary']),
};

// The collaboration schemas get the same typed identity rules the default surface has: an operationId that the
// operation journal accepts, an assumptionId that is a stored entity id, and an "about" that can only name an owner.
Object.entries(collabSchemas).forEach(([, schema]) => annotate(schema, { bareRef: false }));
collabSchemas.team_assume.oneOf[0].properties.about.pattern = '^(member|task|artifact):[A-Za-z0-9:._-]+$';
// Raising names no existing row and answering is guarded by ownership plus status, so neither branch needs a revision.
for (const entry of collabSchemas.team_assume.oneOf) {
  entry.required = entry.required.filter(key => key !== 'expectedRevision');
  entry.properties.expectedRevision = { ...entry.properties.expectedRevision, description: expectedRevisionHint };
}
collabSchemas.team_decision.required = collabSchemas.team_decision.required.filter(key => key !== 'expectedRevision');
collabSchemas.team_decision.properties.expectedRevision = { ...collabSchemas.team_decision.properties.expectedRevision, description: expectedRevisionHint };

const memberId = { ...string, pattern: '^member:[A-Za-z0-9:._-]+$' };
const operationIdField = { ...string, maxLength: 128, pattern: operationIdSource, description: operationIdHint };

/**
 * The intent window is published only when the switch is on, so the default send shape never changes.
 *
 * The simplified send of host-protocol §4.3: a recipient set, the contract revision the interface binds, and no
 * deadline — the server owns the window length. Silence is consent, so the model neither waits for an ack before
 * preparing nor sends a timer of its own.
 */
const intentMessage = object({
  operationId: operationIdField,
  expectedRevision: { ...revision, description: expectedRevisionHint },
  op: { const: 'send' },
  kind: { const: 'intent',
    description: 'intent = the interface you are about to implement against. It opens an objection window: a recipient may answer ok or object, and silence when the window closes counts as ok.' },
  to: { type: 'array', minItems: 1, maxItems: 8, items: memberId,
    description: 'The downstream members that consume this interface (member:<id>). An intent addressed to yourself opens no window.' },
  summary: { ...string, maxLength: 1024,
    description: 'The interface in one sentence: shape, endpoint, assumptions. Detail belongs in bodyRef.' },
  expectedOutcome: { ...string, maxLength: 256, description: 'What a recipient should confirm or object to.' },
  taskRef: { ...string, maxLength: 128, pattern: '^task:[A-Za-z0-9:._-]+$',
    description: 'The task whose contract this intent binds. An intent without a task and a contract revision opens no gate.' },
  contractRevision: { ...revision,
    description: 'The contract revision you are announcing. Publishing that revision waits for this window; a new revision needs a new intent.' },
  bodyRef: { ...string, maxLength: 256 },
}, ['operationId', 'op', 'kind', 'to', 'summary', 'taskRef', 'contractRevision']);

/**
 * Answering an intent (host-protocol §4.3): the model names the messageId and its verdict, never a revision and never
 * a vote table — the server reads the current row and applies the set rule.
 */
const replyMessage = object({
  operationId: operationIdField,
  expectedRevision: { ...revision, description: expectedRevisionHint },
  op: { const: 'reply' },
  messageId: { ...string, pattern: '^message:[A-Za-z0-9:._-]+$',
    description: 'The intent your snapshot carried. Only a recipient of that intent may answer it.' },
  verdict: { enum: ['ok', 'object'],
    description: 'ok = the interface is workable; object = it blocks this contract revision and the window closes as objected.' },
  reason: { ...string, maxLength: 512, description: 'Required in spirit when you object: what breaks, so the sender can send a new revision.' },
}, ['operationId', 'op', 'messageId', 'verdict']);


/**
 * The P1 autonomy tool (design §2.2.2), published only while the switch is on.
 *
 * It is a verdict on an existing row and never a way to create one: no request opens a decision (decision.open is an
 * internal command with no public entry, §2.2.2/A12). The option set is not restated here as the authority -- the row
 * carries the closed set it was opened with and the reducer refuses anything outside it; the schema names the shape
 * and the evidence, so a model is told what a verdict needs before it sends one.
 */
/**
 * P2 §4.2.1/§4.2.2, published only while the autonomy switch is on: the three member branches root needed, beside the
 * default ones rather than inside them.
 *
 *   provision  role + group + workspace in ONE member-intent (memberRef re-assigns an existing member);
 *   group      the group rows themselves: 'create' makes one, 'assign' moves a member that is not live;
 *   request    keeps its old meaning, with the group now optional.
 *
 * Keeping them here is what makes "autonomy off is HEAD" checkable from the outside: `teamSchemasFor('off','off')`
 * returns the same object, not merely an equal one.
 */
const autonomyMemberSchemas = {
  request: withOptional(branch('request', { role: enumeration('subCoordinator|worker|verifier'), group: groupField, subgoalRef: string, reason: string }), ['group']),
  provision: withOptional(branch('provision', { role: enumeration('subCoordinator|worker|verifier'), group: groupField, workspace: workspaceField,
    memberRef: assigneeField, reason: string }), ['group', 'workspace', 'memberRef', 'reason']),
  group: withOptional(branch('group', { group: groupField, mode: enumeration('create|assign'), lead: assigneeField, memberRef: assigneeField, reason: string }), ['mode', 'lead', 'memberRef', 'reason']),
};

/**
 * §3.2.3: the owner-facing accept branch.
 *
 * An owner holds no execution lease and writes no checkpoint, so demanding one would be demanding a fabrication. The
 * branch is part of the autonomy surface only: the default accept keeps requiring checkpointRef exactly as HEAD did.
 */
const ownerAcceptBranch = withOptional(branch('accept', { messageId: string, checkpointRef: string }), ['checkpointRef']);

export const autonomySchemas = {
  // The member surface with the P2 branches layered on; freeze/resume/retire are the default ones, unchanged.
  team_member: { oneOf: [autonomyMemberSchemas.request, autonomyMemberSchemas.provision, autonomyMemberSchemas.group,
    ...teamSchemas.team_member.oneOf.slice(1)] },
  team_decide: object({
    operationId: operationIdField,
    expectedRevision: { ...revision, description: expectedRevisionHint },
    decisionId: { ...string, maxLength: 128, pattern: '^decision:[A-Za-z0-9:._-]+$',
      description: 'One open decision row from your inbox. Rows are opened by the reducer that found something to adjudicate; a request cannot create one.' },
    decision: { ...string, maxLength: 32,
      description: 'One option from that row own closed list (options): waive|uphold|withdraw on an objection, effective|not-effective|abandoned on an unknown effect. Anything else is refused with INVALID_ADJUDICATION.' },
    reason: { ...string, maxLength: 512,
      description: 'Why you decided this. Recorded in the audit row together with your member id and the evidence reference.' },
    evidenceRef: { ...string, maxLength: 256,
      description: 'A stored row that proves the option (message:<id>, attempt:<id>, delivery:<id>). A verdict the evidence contradicts is refused with that row own code (MISSING_EVIDENCE, INVALID_ADJUDICATION) and the decision stays open.' },
  }, ['operationId', 'decisionId', 'decision']),
};
Object.entries(autonomySchemas).forEach(([name, schema]) => {
  annotate(schema, { bareRef: false });
  relaxExpectedRevision(schema, name);
});
// The owner-facing accept branch gets the same typed identity rules the default one has (it is published in place of
// it, and an untyped messageId would be a second, looser contract for the same tool).
annotate(ownerAcceptBranch, { bareRef: false });

/**
 * The message surface with the owner-facing accept branch in place of the default one.
 *
 * Every other branch is kept as it is, including the collaboration ones when that switch is on: the autonomy surface
 * replaces one branch, never the tool.
 */
const withOwnerAccept = message => ({ ...message, oneOf: message.oneOf.map(entry =>
  entry.properties?.op?.const === 'accept' ? ownerAcceptBranch : entry) });

/**
 * The published tool surface for one switch position.
 *
 * collab=off returns `teamSchemas` by identity, so the catalog the default profile publishes is the object it
 * published before this file learned about collaboration. collab=on adds the intent kind and the two new tools.
 */
export function teamSchemasFor(collab = 'off', autonomy = 'off') {
  // P1: the autonomy tool is published beside the collaboration ones and never replaces them, so each switch adds its
  // own surface and neither can move the other's. Both off is still the published default object, by identity.
  const autonomyTools = autonomy === 'on' ? autonomySchemas : null;
  if (collab !== 'on') {
    return autonomyTools
      ? { ...teamSchemas, ...autonomyTools, team_message: withOwnerAccept(teamSchemas.team_message) }
      : teamSchemas;
  }
  // The addressed send stays published (info/action/decision still exist); the intent branch and the reply branch are
  // added beside it, never replacing it.
  const collabSurface = { ...teamSchemas, team_message: { oneOf: [teamSchemas.team_message.oneOf[0], intentMessage,
    ...teamSchemas.team_message.oneOf.slice(1), replyMessage] }, ...collabSchemas };
  return autonomyTools
    ? { ...collabSurface, ...autonomyTools, team_message: withOwnerAccept(collabSurface.team_message) }
    : collabSurface;
}

/**
 * The published tool surface for a protocol position; design §2, §10 P0.
 *
 * The whole point of the golden baseline is that "off" is not merely equal to HEAD's surface but IS it, by object
 * identity, for every collaboration and autonomy position. So borrow off delegates to teamSchemasFor and returns its
 * result unchanged - the catalog hash a default profile pins cannot move. The integration candidate publishes the
 * explicit v1 contract below; runtime and shared command validation consume that same surface. Publication does NOT
 * change assertProtocolSupported: protocol activation still requires the complete integration acceptance matrix.
 */

// Published v1 model contract is independent of activation readiness. Off retains the legacy object by identity.
function borrowSchemas() {
  const surface = structuredClone(teamSchemasFor('on', 'on'));
  const request = object({ operationId: operationIdField, expectedRevision: revision, op: { const: 'send' },
    kind: { const: 'intent' }, to: { const: 'member:root' }, summary: { ...string, maxLength: 1024 },
    reason: { ...string, maxLength: 512 }, evidenceRefs: { ...strings, minItems: 1 }, taskRef: string,
    contractRevision: revision, expectedOutcome: { ...string, maxLength: 256 }, bodyRef: string, previousDecisionId: string },
    ['operationId','op','kind','to','summary','reason','evidenceRefs','taskRef','contractRevision','expectedOutcome']);
  surface.team_message.oneOf = surface.team_message.oneOf.filter(b => b.properties.op.const !== 'reply' && b.properties.kind?.const !== 'intent');
  surface.team_message.oneOf.push(request);
  const resource = object({ kind: { enum: ['branch','pr','file-area'] }, repositoryKey: string,
    key: { oneOf: [string, object({ provider: string, repository: string, number: { type: 'integer', minimum: 1 } })] } });
  surface.team_thread.oneOf.push(
    withOptional(branch('open-resource', { resource, descriptionRef: string }), ['expectedRevision']),
    withOptional(branch('subscribe', { issueId: string, memberId: memberId, replayFrom: { type: 'integer', minimum: 1 } }), ['memberId','replayFrom']),
    withOptional(branch('unsubscribe', { issueId: string, memberId: memberId, reason: string }), ['memberId']),
    withOptional(branch('publish', { issueId: string, eventType: { ...string, maxLength: 64 }, summary: { ...string, maxLength: 1024 }, bodyRef: string }), ['bodyRef']),
    branch('close-resource', { issueId: string, reason: string }));
  surface.team_read = { oneOf: [surface.team_read,
    object({ view: { const: 'thread-events' }, ref: string, afterSeq: revision, limit: { type: 'integer', minimum: 1, maximum: 50 } }, ['view','ref'])] };
  // Autonomy's decision row is the closed option authority; publish coordination evidence without M2b prose.
  surface.team_decide.properties.decision.description = 'One option from the decision row: coordination uses approve|reject|request-revision. No silence-pass or self approval.';
  for (const [name, schema] of Object.entries(surface)) annotate(schema, { bareRef: name === 'team_read' });
  return surface;
}

export function teamSchemasForBorrow(borrow = 'off', collab = 'off', autonomy = 'off') {
  if (borrow === 'off') return teamSchemasFor(collab, autonomy);
  if (borrow === 'v1') return borrowSchemas();
  fail('INVALID_CONFIG');
}

/** Filter SDK tools by the four business roles; 08 §4.10. */
export function roleTools(role, collab = 'off', autonomy = 'off', borrow = 'off') {
  const extra = { root: ['team_plan', 'team_member', 'team_goal'], subCoordinator: ['team_plan', 'team_task'],
    worker: ['team_task'], verifier: ['team_verify'] };
  if (!extra[role]) fail('UNKNOWN_ROLE');
  const schemas = teamSchemasForBorrow(borrow, collab, autonomy);
  // team_assume is a peer tool for every executing role; team_decision is for whoever is doing work that others
  // depend on, which is every role except the independent verifier (its verdict is already its record).
  const collabExtra = collab === 'on' ? (role === 'verifier' ? [] : ['team_assume', 'team_decision']) : [];
  // §2.2.2/§9.1: the decision inbox belongs to the owner alone. A worker or a verifier calling team_decide does not
  // even have the tool, so the refusal is ROLE_DENIED from the surface itself, not a reducer verdict.
  const autonomyExtra = autonomy === 'on' && role === 'root' ? ['team_decide'] : [];
  return Object.fromEntries(['team_read', 'team_message', 'team_thread', 'team_wait', ...extra[role], ...collabExtra,
    ...autonomyExtra].map(key => [key, schemas[key]]));
};
