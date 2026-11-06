import { delegation } from './collab-fake.mjs';
import { taskBrief } from './collab-task/brief.mjs';
import { workspaceOf } from './collab-session.mjs';
import { deliverable, deliverablePath, executors, deliveryRefOf } from './collab-prompts.mjs';

/** Delegation and task binding: the first durable action each member receives. */
/**
 * Root delegates one durable action per member. The messages are the responsibility the members accept as their first
 * step; their ids are captured here because the plan below refers to them.
 */
export async function delegate(engine) {
  // One task and one admitted attempt per member. The stage owns admission here instead of the worker bootstrap
  // because the members only exist once the collaboration topology is loaded, and the attempt is the lease the
  // team tools authenticate against.
  // F2: the task states the paths its attempt may write - the member's own workspace - so the ordinary-effect fence
  // has a lease scope to compare a real native write against. The workspace itself comes from the product's
  // memberWorkspace hook (the session cwd); this line only declares that the workload means it.
  for(const actor of ['be','fe','qa','verifier']){const taskRef='task:collab:'+actor;const state=engine.states.get(actor);state.task=taskRef;engine
    .submit('team.task.request',taskRef,{owner:'member:'+actor,scopeSet:[workspaceOf(engine,actor)],...(['be','fe','qa'].includes(actor)?{
            plannedDelivery:'delivery:collab:'+actor+':v1'}:{})});
    }
  for(const actor of ['be','fe','qa','verifier'])await bindTask(engine,actor,'task:collab:'+actor);
  engine.install(engine.states.get('root'));
  for (const actor of ['be', 'fe', 'qa', 'verifier']) {
    const part = actor === 'verifier'
      ? deliverable(actor) + ': one team_verify per executor delivery (' + executors.map(x => deliveryRefOf(x)).join(', ') + ')'
      : deliverable(actor) + ' in ' + deliverablePath[actor] + ' at your workspace root, submitted with team_task op=produce deliveryRef=' + deliveryRefOf(
        actor);
    const sent = engine.runtime.host.executeAuthorized('business',()=>engine.core.send('member:root', 'member:' + actor, 'action',
      'Objective: ' + taskBrief.objective + ' Your part: ' + part + '. The interface is not specified: agree it with the members who consume your part.',
      { expectedOutcome: 'your part produced in your own workspace and submitted for acceptance',
        deadline: new Date(Date.now() + 1500000).toISOString() }));
    delegation[actor] = sent.result.entityId;
  }
  engine.facts.collab.delegated = Object.entries(delegation).map(([actor, messageId]) => ({ actor: 'member:' + actor, messageId }));
  return delegation;
}

/**
 * A fresh lease for a member that has already delivered. Producing finishes the attempt, so the next round of work
 * (answering an assumption, reacting to the requirement change) needs its own task and attempt, exactly as a new
 * assignment would in production. Re-admitting keeps every round authenticated against a live lease instead of
 * pretending a finished one is still valid, which is what INVALID_LEASE means.
 */
export async function bindTask(engine,actor,taskRef){
 const state=engine.states.get(actor),end=Date.now()+120000;
 for(;;){const route=engine.runtime.router.route(engine.agent(actor).session.id);if(route?.attemptId&&engine.core.store.read(route
       .attemptId)?.taskId===taskRef){state.binding={attemptId:route.attemptId,fence:route.fence,generation:route.generation};state.task=taskRef;
         state.admittedAt=
       Date
     .now();engine.install(state);return state.binding;}if(Date.now()>end)throw Error('COLLAB_BIND_TIMEOUT:'+actor);await new Promise(r=>setTimeout(r,10));
   }
}
