import { drain as consumeInputs } from '../../../core/index.mjs';
/** Host admission step. Called only through the lifecycle capability; never owns lifecycle IO. */
export function drain(core, now) { return consumeInputs(core, now); }
