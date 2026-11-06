// Semantics fixtures for 09 §8 A8 / A4 / A7 (pure, node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarioDefault, scenarioLarge, scenarioEmpty, createMockSource, MOCK_VIEWER } from '../src/mock.mjs';
import { memberSeverity, counts, needsYou, pipelineCounts, StableOrder, groupRows, ackSummary, deadlineSeverity, rootMember } from '../src/model.mjs';
import { ProjectionClient, applyEvent, freshness, FRESHNESS, GATE_RATIO } from '../src/projection.mjs';
// The bundle boundary forces ui to state the ratio itself (build.mjs strips imports); this is the pin that keeps the
// display copy equal to the one the server gates with (contracts, re-exported by packages/context).
import { GATE_RATIO as SERVER_GATE_RATIO } from '../../contracts/index.mjs';
import { COMMANDS, UNSUPPORTED_COMMANDS, unsupportedReason, resolveTeamConfig } from '../src/projection.mjs';
import { createRealSource, commentKind } from '../src/real-source.mjs';
import { goalInfo, contextKnown, approvalsKnown, ctxLevel, CONTEXT_WARN, CONTEXT_FULL } from '../src/model.mjs';
import { createUiStore, nextSidebarTab, frameTransition } from '../src/store.mjs';
import { sessionMember, miniStatus, taskAttempts, deliveryInfo, certificateBinding } from '../src/model.mjs';


export const NOW = Date.UTC(2026, 9, 26, 14, 6);
export const data = scenarioDefault(NOW);
export const M = name => 'member:' + name; // authoritative member ids (core)
export const sev = name => memberSeverity(data.members.find(m => m.id === M(name)), { now: NOW, messages: data.messages });

