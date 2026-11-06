export type VersionedId<Kind extends string> = string & {
  readonly kind: Kind;
  readonly schemaVersion: 1;
};

export type SessionRef = {
  session: string;
  agent: string;
};

export type ExecutionState = 'OPEN' | 'SEALING' | 'DRAINING' | 'PROVEN' | 'RELEASED' | 'UNVERIFIED';
export type ExecutionOutcome = 'executed' | 'notExecuted' | 'unknown';
export type RetryPolicy = 'allowed' | 'forbidden' | 'exhausted';
export interface ExecutionIdentity {
  readonly teamId: string; readonly memberId: string; readonly generation: number;
  readonly executionSessionId: string; readonly attemptId: string; readonly attemptFence: number; readonly executionEpoch: string;
}
export interface ExecutionCoverage {
  gates: boolean; attribution: boolean; transport: boolean; subprocess: boolean; complete: boolean;
  [capability: string]: boolean;
}
export interface ExecutionStopCertificate {
  kind: 'stop-proof'; contract: 'execution-stop/1'; E: ExecutionIdentity;
  stopId: string; scopeVersion: number; certificateId: string | null; coverage: ExecutionCoverage;
  verified: boolean; stopState: 'proven' | 'unverified';
}
export declare const EXECUTION_STATES: readonly ExecutionState[];
export declare const EXECUTION_ID_FIELDS: readonly (keyof ExecutionIdentity)[];
export declare function sameExecution(a: unknown, b: unknown): boolean;
export declare function executionIdentity(value: unknown): Readonly<ExecutionIdentity>;
export declare function executionScopeId(E: ExecutionIdentity): string;
export declare function scopeCertificateMatches(row: unknown, proof: unknown): boolean;

export interface ContextConfig {
  schemaVersion: 1;
  profile: 'default';
  W: number;
  R: number;
  M: number;
  truncateChars: number;
  fold: false;
}

export interface Command<Payload> {
  operationId: VersionedId<'operation'>;
  actor: string;
  expectedRevision: number;
  payloadHash: string;
  payload: Payload;
}

export interface ArtifactRef {
  artifactRef: VersionedId<'artifact'>;
  sha256: string;
  bytes: number;
  callId: string;
  mediaType: string;
}

export type RecallFailure = 'denied' | 'expired' | 'corrupt';

export interface BudgetObservation {
  I: number;
  W: number;
  R: number;
  M: number;
  purpose: 'main' | 'summary' | 'retry' | 'replay' | string;
}

/** The autonomy switch; P0 of docs/decisions/team-autonomy-design.md §10. Nothing reads these values yet. */
export interface AutonomyConfig {
  autonomy: 'off' | 'on';
  goalGate: { strict: boolean; legacy: 'adopt-tail' };
  stopGraceMs: number;
  stopProofTimeoutMs: number;
  decisionTtlMs: number;
  budget: { unknownUsage: 'continue' | 'stop'; unknownGraceMs: number };
  pricing: { currency: string; perInputToken: number; perOutputToken: number } | null;
}

/** Validate and freeze the autonomy configuration; unknown keys and out-of-range values are INVALID_CONFIG. */
export function autonomyConfig(configuration?: Partial<AutonomyConfig>): Readonly<AutonomyConfig>;

/** The refusal codes the autonomy packages introduce, grouped by the design section that raises them. */
export const AUTONOMY_CODES: Readonly<Record<'decision' | 'goal' | 'stop' | 'budget' | 'message' | 'owner' | 'workspace' | 'config', readonly string[]>>;

/** The same table flattened. */
export const autonomyCodeList: readonly string[];

/** Validate and freeze context configuration; 08 §1.3, §3.2–3.4. */
export function config(configuration?: Partial<ContextConfig>): Readonly<ContextConfig>;
/** The context hard limit (75% of the window); the gate reads the input alone against it. */
export const GATE_RATIO: 0.75;

/** Create a versioned stable identifier; 08 §2.2. */
export function id<Kind extends string>(kind: Kind): VersionedId<Kind>;

/** Hash command payload or evidence bytes; 08 §2.2–3.3. */
export function hash(data: string | Uint8Array): string;

/** Super-agent borrow P0: only off is implemented; parsing a value never activates it. */
export type BorrowProtocol = 'off' | 'v1';
export type IntentSemantics = 'undecided' | 'root-decision-v1' | 'silence-pass-m2b';
export interface OwnerModel { readonly provider: string; readonly model: string; }
export interface SuperagentBorrowConfig {
  readonly superagentBorrow: BorrowProtocol;
  readonly ownerModel: Readonly<OwnerModel> | null;
  readonly intentSemantics: IntentSemantics;
}
export interface BorrowBlocker { readonly id: string; readonly detail: string; }
export interface BorrowReadiness { readonly ready: boolean; readonly blockers: readonly BorrowBlocker[]; }
export const SUPERAGENT_BORROW_DEFAULTS: Readonly<SuperagentBorrowConfig>;
export const SUPERAGENT_BORROW_CODES: Readonly<Record<'protocol' | 'guard' | 'coordination' | 'thread' | 'batch' | 'model' | 'capacity', readonly string[]>>;
export const superagentBorrowCodeList: readonly string[];
/** Hoisted initialization helper; same single-source refusal table. */
export function superagentBorrowCodes(): typeof SUPERAGENT_BORROW_CODES;
export const INTENT_SEMANTICS_VALUES: readonly IntentSemantics[];
export const BORROW_POLICY_VERSION: 1;
export const BORROW_IMPLEMENTATION: Readonly<{ off: 'implemented'; v1: 'contract-only' }>;
/** §10 P1/P2: per-mechanism implementation state; v1 stays 'contract-only' until every stage is implemented. */
export const BORROW_IMPLEMENTATION_STAGES: Readonly<Record<'s1' | 's2' | 's3' | 's4' | 's5', Readonly<{
  id: string; section: string; status: 'implemented' | 'contract-only'; detail: string;
}>>>;
export function unimplementedBorrowStages(): readonly Readonly<{ id: string; section: string; status: string; detail: string }>[];
/** §12: the deployment value that selects the explicit-root-decision semantics P1 implements. */
export const ROOT_DECISION_SEMANTICS: 'root-decision-v1';
export const SUPERAGENT_BORROW_OPEN_QUESTIONS: readonly Readonly<{
  id: string; section: string; question: string; unresolvedValue: 'undecided'; values: readonly IntentSemantics[];
  selectedValue: 'root-decision-v1'; decidedAt: '2026-11-01'; source: string;
}>[];
export function ownerModelConfig(value: unknown): Readonly<OwnerModel> | null;
export function superagentBorrowConfig(overrides?: Partial<SuperagentBorrowConfig>): Readonly<SuperagentBorrowConfig>;
export function borrowOptions(source?: unknown): Partial<SuperagentBorrowConfig>;
export function borrowReadiness(configuration?: Partial<SuperagentBorrowConfig> | null): BorrowReadiness;
export function assertProtocolSupported(configuration?: Partial<SuperagentBorrowConfig> | null): BorrowReadiness;
export function assertBorrowPreconditions(value?: {
  team?: boolean; guard?: boolean; goalCheck?: boolean; autonomy?: 'off' | 'on'; collab?: 'off' | 'on';
}): true;
export interface TeamPolicyRow {
  readonly version: 1; readonly superagentBorrow: BorrowProtocol;
  readonly activatedAt: string; readonly migrationRef: string | null;
}
export function teamPolicyRow(teamId: string, value?: {
  superagentBorrow: BorrowProtocol; activatedAt: string | Date; migrationRef: string | null;
}): Readonly<TeamPolicyRow>;
export interface PolicyDecision { readonly decision: 'fresh' | 'match' | 'mismatch'; readonly reason: string | null; }
export function policyDecision(persisted: unknown, configured: BorrowProtocol): PolicyDecision;
export function assertPolicyCompatible(persisted: unknown, configured: BorrowProtocol): PolicyDecision;
export interface MigrationObservation {
  admissionStopped: boolean; activeExecutions: number; unknownExecutions: number;
  applyingEffects: number; unknownEffects: number; openIntentWindows: number; openObjections: number;
  migrationSummaryRef: string | null; hostStopped: boolean;
}
export interface MigrationPrerequisite { readonly id: string; readonly requirement: string; }
export interface MigrationCheck {
  readonly ready: boolean; readonly unsatisfied: readonly string[];
  readonly checks: readonly Readonly<MigrationPrerequisite & { satisfied: boolean }>[];
}
export const MIGRATION_PREREQUISITES: readonly MigrationPrerequisite[];
export function migrationCheck(observation?: Partial<MigrationObservation>): MigrationCheck;
export function assertMigrationReady(observation: MigrationObservation): MigrationCheck;
export function canonical(value: unknown): string;
export function digest(value: unknown): string;
export type ToolCapability = 'read-local' | 'coordinate' | 'execute' | 'write-local' | 'opaque';
export interface ToolRolePolicy {
  readonly principalKind: string; readonly deny: readonly ToolCapability[];
  readonly allow: readonly ToolCapability[]; readonly unknown: 'deny';
}
export const TOOL_CAPABILITIES: readonly ToolCapability[];
export const ROOT_TOOL_POLICY: Readonly<ToolRolePolicy>;
/** Templates only: P2 must bind these to trusted instances and refine per-operation capabilities. */
export const TOOL_CAPABILITY_DECLARATIONS: Readonly<Record<string, readonly ToolCapability[]>>;
export function capabilityDeclaration(identity: unknown): Readonly<{ identity: string; capabilities: readonly ToolCapability[] }> | null;
export function toolCapabilityDecision(policy: ToolRolePolicy, capabilities: unknown): Readonly<{
  decision: 'allow' | 'deny'; reason: null | 'UNDECLARED_TOOL' | 'UNKNOWN_CAPABILITY' | 'CAPABILITY_DENIED' | 'CAPABILITY_NOT_ALLOWED';
  capabilities?: readonly ToolCapability[];
}>;
/** §4.1 P2: per-operation refinement of the team tool templates; an operation not named here is denied. */
export const TOOL_OPERATION_CAPABILITIES: Readonly<Record<string, Readonly<Record<string, readonly ToolCapability[]>>>>;
export function toolOperationCapabilities(identity: unknown, operation: unknown): readonly ToolCapability[] | null;
