import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILD, BUILD_C2, TARGET_REL, TYPES_REL, sha256, discover } from './discover.mjs';

/**
 * Apply the instant-preempt candidate (C2) to the independent build.
 *
 * Every edit replaces a literal string that discover.mjs proved exists with an exact multiplicity, and the
 * preimage hashes are asserted on the source and the destination first. The script therefore cannot patch a
 * build it did not expect, cannot patch twice, and cannot "get close" when a structure moved.
 */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const fail = code => { const e = new Error(code); e.code = code; throw e; };

const pick = (blocks, name) => {
  const block = blocks[name];
  if (block === void 0) fail('ANCHOR_MISSING:' + name);
  return block.text;
};

/** One literal replacement with an exact expected count, verified before anything is written. */
const replace = (source, name, from, to, expected = 1) => {
  const count = source.split(from).length - 1;
  if (count !== expected) fail('ANCHOR_DRIFT:' + name + ':expected ' + expected + ':found ' + count);
  return source.split(from).join(to);
};

const PREEMPT_SENTINEL = `/** Race result meaning "a step-scoped preemption won"; a symbol so no chunk or error can be mistaken for it. */
const PREEMPTED = Symbol("instant-preempt");
/**
* Close a stream the loop is abandoning. Calling return() is mandatory: it is what releases the adapter's
* connection and it propagates through dsh-llm's own iterator cleanup. A pending next() can make return()
* wait on the provider, so the close is bounded instead of stalling the turn that is switching course.
*/
async function closeStream(iterator) {
	if (typeof iterator.return !== "function") return;
	// for-await swallows a return() failure on abrupt completion; the original error is the one that matters.
	try { await iterator.return(); } catch {}
}
/**
* Preemption-only close. return() is still called — that is what releases the adapter's connection and
* propagates through dsh-llm's own iterator cleanup — but it is NOT awaited on this path. Awaiting it is what
* makes a preemption cost the abandoned request's own latency: with a real provider the pending next() cannot
* settle until the response arrives, so the step that was supposed to switch course waits for the request it
* just abandoned (measured: exactly the 2s bound, on every preempted delivery). The release still happens, one
* microtask later; it is raced against a short unref'd timer only so a provider that never answers cannot pin
* the process, and the race itself is not awaited either.
*/
function closePreemptedStream(iterator) {
	if (typeof iterator.return !== "function") return;
	const closing = Promise.resolve().then(() => iterator.return()).catch(() => {});
	const bounded = new Promise((resolve) => {
		const timer = setTimeout(resolve, 2000);
		timer.unref?.();
	});
	// Swallowed on purpose: the stream is already abandoned, so a failure to close it cannot become an error of
	// the step that continued past it.
	Promise.race([closing, bounded]).catch(() => {});
}
`;

const PREEMPT_CONTROL = `	/** Arm one step-scoped preempt latch; undefined when the candidate is disabled or no step is running. */
	beginPreempt() {
		// The flag lives on the agent-loop service, which is the context this driver was built from.
		if (this.loopCtx.agentLoop.config.instantInterrupt !== true || this.phase.kind !== "running") return void 0;
		const armed = Promise.withResolvers();
		const guard = {
			turn: this.phase.turn,
			step: this.phase.step,
			reason: null,
			controller: new AbortController(),
			next: armed.promise,
			armed: true
		};
		guard.listener = () => armed.resolve(PREEMPTED);
		guard.controller.signal.addEventListener("abort", guard.listener, { once: true });
		this.preempt = guard;
		return guard;
	}
	/**
	* Disarm the latch at its step boundary. The controller is left aborted on purpose: a plugin still holding
	* the signal observes a closed step instead of waiting forever, including after cancel or dispose.
	*/
	endPreempt(guard) {
		if (guard === void 0) return;
		guard.armed = false;
		guard.controller.signal.removeEventListener("abort", guard.listener);
		if (!guard.controller.signal.aborted) guard.controller.abort("step-end");
		if (this.preempt === guard) this.preempt = void 0;
	}
	/**
	* Request one preemption of the current step from trusted plugin code. At most one per step and never the
	* turn: the driver re-enters pre-step and claims whatever the caller queued in the meantime.
	* @param reason - evidence label for the trigger; it becomes the latch signal's abort reason.
	* @returns whether a live latch accepted the request.
	*/
	preemptStep(reason = "preempted") {
		if (this.phase.kind !== "running" || this.phase.abort.signal.aborted) return false;
		const guard = this.preempt;
		if (guard === void 0 || !guard.armed || guard.controller.signal.aborted) return false;
		guard.reason = reason;
		guard.controller.abort(reason);
		return true;
	}
	/** The live step's preempt signal, or undefined outside a step. */
	get preemptSignal() {
		return this.preempt === void 0 ? void 0 : this.preempt.controller.signal;
	}
	/**
	* Settle a preempted attempt as an attempt, never as a message. An open text or reasoning block would be a
	* truncated item, and a partial reasoning signature is rejected on the next request, so nothing partial
	* becomes model-visible content; items completed by earlier steps are already durable and untouched.
	*/
	settlePreempt(live, turn, step, request) {
		const kept = [];
		for (const index of live.assembler.order) {
			const partial = live.assembler.partials.get(index);
			if (partial.block === void 0) {
				this.preemptStats.discardedPartialItems++;
				continue;
			}
			// A tool call is never kept: it was not dispatched, and keeping it would demand a fabricated output.
			if (partial.block.type !== "text" && partial.block.type !== "reasoning") continue;
			if (partial.block.text.trim() === "") continue;
			kept.push(partial.block);
		}
		this.preemptStats.fired++;
		this.preemptCausedNext = true;
		// Closed items keep their exact bytes and reasoning signature; open ones are dropped, never truncated.
		if (kept.length > 0) live.settle("assistant/message", () => this.session.append("assistant/message", {
			turn,
			step,
			message: createAssistantMessage({
				content: kept,
				source: {
					provider: request.provider,
					model: request.model
				}
			}),
			interrupted: true,
			...live.usage === void 0 ? {} : { usage: live.usage },
			stream: live.stream
		}, { surfaceOp: "append" }).seq);
		else live.settle("assistant/attempt", () => this.session.append("assistant/attempt", {
			turn,
			step,
			stream: live.stream
		}).seq);
	}
	/** Charge the next request, which exists only because this step was preempted, so its cost is measured. */
	attributePreempt(usage) {
		if (!this.preemptCausedNext) return;
		this.preemptCausedNext = false;
		const stats = this.preemptStats;
		stats.extraRequests++;
		if (usage !== void 0) {
			stats.extraInputTokens += usage.inputTokens ?? 0;
			stats.extraOutputTokens += usage.outputTokens ?? 0;
		}
	}
`;

/** Build the full replacement plan from discovered blocks; pure, so the probe reuses one definition. */
export function buildCandidate(blocks) {
  const index = [];
  const types = [];

  // 1. Per-agent preempt state and honesty counters, next to the phase they belong to.
  const phaseField = pick(blocks, 'phaseField');
  index.push(['phaseField', phaseField, phaseField + `
	/** Live step-scoped preempt latch; undefined outside a step or when the candidate is disabled. */
	preempt;
	/** Counters for the verification metric surface; never inferred from timing. */
	preemptStats = {
		fired: 0,
		discardedPartialItems: 0,
		extraRequests: 0,
		extraInputTokens: 0,
		extraOutputTokens: 0
	};
	/** Whether the next settled request is one that a preemption made necessary. */
	preemptCausedNext = false;`, 1]);

  // 2. Split step() so the latch is armed and disarmed on every exit path without re-indenting the body.
  index.push(['stepMethod', `	async step(decision) {`, `	async step(decision) {
		const guard = this.beginPreempt();
		try {
			return await this.runStep(decision);
		} finally {
			this.endPreempt(guard);
		}
	}
	/** One step body; the candidate changes how an interrupted stream settles and how tools stop starting. */
	async runStep(decision) {`, 1]);

  // 3. A step-local preempt marker that survives the stream try/catch.
  const stepHead = pick(blocks, 'stepBodyHead');
  index.push(['stepBodyHead', stepHead, stepHead + `

		let preempted = false;`, 1]);

  // 4. Manual iteration so a preemption can win the read, then close the stream instead of leaking it.
  const streamLoop = pick(blocks, 'streamLoop');
  index.push(['streamLoop', streamLoop, `				const stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request);
				signal.throwIfAborted();
				live.start();
				started = true;
				const latch = this.preempt;
				const iterator = stream[Symbol.asyncIterator]();
				let drained = false;
				try {
					while (true) {
						const read = iterator.next();
						// A losing next() may still reject after the preemption wins; contain it so it is never unhandled.
						read.catch(() => {});
						const next = latch === void 0 ? await read : await Promise.race([read, latch.next]);
						if (next === PREEMPTED) {
							preempted = true;
							break;
						}
						if (next.done) {
							drained = true;
							break;
						}
						signal.throwIfAborted();
						live.push(next.value);
					}
					signal.throwIfAborted();
				} finally {
					// Same contract as for-await: close the iterator unless it reported done, so a turn abort,
					// a push failure and a preemption all release the adapter stream instead of leaking it.
					if (!drained) await (preempted ? closePreemptedStream(iterator) : closeStream(iterator));
				}`, 1]);

  // 5. Settle the preemption outside the stream try/catch so a settlement failure can never settle twice.
  const finishOpen = pick(blocks, 'finishOpen');
  index.push(['finishOpen', finishOpen, `			if (preempted) {
				this.settlePreempt(live, turn, step, request);
				return null;
			}
` + finishOpen, 1]);

  // 6. Charge the request a preemption made necessary, at its own settlement point.
  const finishLine = pick(blocks, 'finishLine');
  index.push(['finishLine', finishLine, `				this.attributePreempt(live.usage);
` + finishLine, 1]);

  index.push(['sentinel', 'var ReactLoopAgent = class', PREEMPT_SENTINEL + '// boundary-wake/1: wakeDriver reserves running independently of instantInterrupt.\n' + 'var ReactLoopAgent = class', 1]);

  // 10. The control surface trusted plugins call.
  const cancelMethod = pick(blocks, 'cancelMethod');
  index.push(['cancelMethod', cancelMethod, PREEMPT_CONTROL + cancelMethod, 1]);

  // 11. The config flag, declared and carried through the validated config object.
  const configField = pick(blocks, 'configField');
  index.push(['configField', configField, configField + `
		instantInterrupt: z.boolean().default(false),`, 1]);
  const loopConfig = pick(blocks, 'loopConfig');
  index.push(['loopConfig', loopConfig, `		this.config = {
			agents: applyLauncherIdentities(config.agents, ctx.get(CONFIGURED_AGENT_IDENTITIES_KEY)),
			maxParallelToolCalls: config.maxParallelToolCalls,
			instantInterrupt: config.instantInterrupt === true
		};`, 1]);

  // Types: the opt-in flag and the runtime surface a trusted plugin may inspect.
  const typesConfigField = pick(blocks, 'typesConfigField');
  types.push(['typesConfigField', typesConfigField, typesConfigField + `
    /** Opt-in step-scoped preemption (instant-preempt candidate). Default off keeps upstream behaviour. */
    instantInterrupt?: boolean;`, 1]);
  const typesStaticConfig = pick(blocks, 'typesStaticConfig');
  types.push(['typesStaticConfig', typesStaticConfig, typesStaticConfig + `
        instantInterrupt?: boolean;`, 1]);
  const typesDoc = pick(blocks, 'typesDoc');
  types.push(['typesDoc', typesDoc, `/** Step-scoped preemption surface exposed by the instant-preempt candidate build. */
export interface AgentPreemptSurface {
    /** Request one preemption of the current step; false when no latch is armed, already fired, or outside a step. */
    preemptStep(reason?: string): boolean;
    /** The live step's preempt signal, or undefined outside a step or when the candidate is disabled. */
    readonly preemptSignal: AbortSignal | undefined;
    /** Counters the verification metric surface reports; they are never inferred from timing. */
    readonly preemptStats: {
        fired: number;
        discardedPartialItems: number;
        extraRequests: number;
        extraInputTokens: number;
        extraOutputTokens: number;
    };
}
` + typesDoc, 1]);

  return { index, types };
}

/** Apply the same anchored candidate to an independent prepared copy, without touching the source or legacy build. */
export function applyToCopy(target) {
  const anchors = JSON.parse(fs.readFileSync(path.join(ROOT, 'anchors.json'), 'utf8'));
  const pre = { indexJs: sha256(target + '/' + TARGET_REL), typesDts: sha256(target + '/' + TYPES_REL) };
  if (pre.indexJs !== anchors.preimage.indexJs || pre.typesDts !== anchors.preimage.typesDts) fail('PREIMAGE_MISMATCH');
  const { blocks, source, typeSource, problems } = discover(target);
  if (problems.length) fail('ANCHOR_DRIFT');
  const plan = buildCandidate(blocks);
  let indexText = source, typesText = typeSource;
  for (const [name, from, to, count] of plan.index) indexText = replace(indexText, name, from, to, count);
  for (const [name, from, to, count] of plan.types) typesText = replace(typesText, name, from, to, count);
  if (indexText === source || typesText === typeSource) fail('NO_CHANGE');
  fs.writeFileSync(target + '/' + TARGET_REL, indexText);
  fs.writeFileSync(target + '/' + TYPES_REL, typesText);
  return { preimage: pre, edits: plan.index.length + plan.types.length };
}

const run = () => {
  const anchorsPath = path.join(ROOT, 'anchors.json');
  if (!fs.existsSync(anchorsPath)) fail('DISCOVERY_REQUIRED');
  const anchors = JSON.parse(fs.readFileSync(anchorsPath, 'utf8'));
  const pre = { indexJs: sha256(BUILD + '/' + TARGET_REL), typesDts: sha256(BUILD + '/' + TYPES_REL) };
  if (pre.indexJs !== anchors.preimage.indexJs || pre.typesDts !== anchors.preimage.typesDts) fail('PREIMAGE_MISMATCH');
  const destination = { indexJs: sha256(BUILD_C2 + '/' + TARGET_REL), typesDts: sha256(BUILD_C2 + '/' + TYPES_REL) };
  if (destination.indexJs !== pre.indexJs || destination.typesDts !== pre.typesDts) fail('BUILD_NOT_PRISTINE');

  const { blocks, source, typeSource } = discover();
  const plan = buildCandidate(blocks);
  let indexText = source;
  let typesText = typeSource;
  for (const [name, from, to, count] of plan.index) indexText = replace(indexText, name, from, to, count);
  for (const [name, from, to, count] of plan.types) typesText = replace(typesText, name, from, to, count);
  if (indexText === source || typesText === typeSource) fail('NO_CHANGE');

  fs.writeFileSync(BUILD_C2 + '/' + TARGET_REL, indexText);
  fs.writeFileSync(BUILD_C2 + '/' + TYPES_REL, typesText);

  const after = { indexJs: sha256(BUILD_C2 + '/' + TARGET_REL), typesDts: sha256(BUILD_C2 + '/' + TYPES_REL) };
  const report = {
    candidate: 'instant-preempt-0.2.2-rc.1',
    build: BUILD_C2,
    base: BUILD,
    applied: { index: plan.index.map(([name]) => name), types: plan.types.map(([name]) => name) },
    preimage: pre,
    postimage: after,
    changed: [
      { path: TARGET_REL, sha256Before: pre.indexJs, sha256After: after.indexJs },
      { path: TYPES_REL, sha256Before: pre.typesDts, sha256After: after.typesDts },
    ],
    at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(ROOT, 'hashes-and-scope.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(ROOT, 'hashes.txt'), [TARGET_REL, pre.indexJs, after.indexJs, TYPES_REL, pre.typesDts, after.typesDts].join('\n') + '\n');
  console.log(JSON.stringify({ ok: true, edits: plan.index.length + plan.types.length, preimage: pre, postimage: after }, null, 2));
};

const asPath = p => p.replaceAll('\\', '/').toLowerCase();
if (process.argv[1] && asPath(fileURLToPath(import.meta.url)) === asPath(process.argv[1])) run();