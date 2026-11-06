import {policy} from './config.mjs';
/**
 * The window a stage may spend without a committed signal that the team is still working.
 *
 * The collaboration stage measures its window from progress the workload itself reports (a finished round, an
 * integration, a produced delivery, a verification, a workspace write). Measured from the start of the stage, as it
 * was before, the window was not a progress guard at all: the fourth real run of the control arm ended at
 * startedAt+900000 with every member in the middle of the requirement change, after an integration that had already
 * copied all three artifacts. The release stages keep the release window and their own start-based clock.
 */
export const progressWindowMs=stage=>stage==='collab'?policy.collabNoProgressMs:policy.noProgressMs;
export function stopReason({stopRequested,stage,started,lastProgress,now=Date.now()}){
  if(stopRequested)return 'SIGNAL_STOP';
  if(stage==='soak'&&now-started>=policy.soakDurationMs)return 'TIME_STOP';
  // The stage's wall clock is a different fact from its progress window and gets a different code: a run ended here
  // hit its own ceiling, not silence. Merging the two is what made the last control run look like a stalled team.
  if(stage==='collab'&&now-started>=policy.collabDurationMs)return 'STAGE_TIME_LIMIT';
  if(now-lastProgress>=progressWindowMs(stage))return 'NO_PROGRESS_STOP';
  return null;
}
