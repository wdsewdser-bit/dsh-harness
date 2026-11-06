/**
 * The task the collaboration stage hands its members, and the requirement change injected mid-run.
 *
 * Per plan 11 section 3 the brief deliberately specifies no interface: no endpoint list, no JSON shape, no field names.
 * The three executors have to agree on the contract themselves, which is exactly what mechanism 1 is about. The change
 * is a second user message, delivered after the first integration attempt, so the report can measure how long each
 * affected member takes to react to it.
 */
export const taskBrief = {
  objective: 'Build a small full-stack tagged-todo application in your own workspace and get it accepted.',
  team: { root: 'coordinates, integrates, decides', fe: 'frontend page', be: 'backend API and storage',
    qa: 'end-to-end tests', verifier: 'independent acceptance' },
  text: [
    'Product: a tagged todo list. A user can add a todo with a title and optional tags, list todos, mark one done, and delete one.',
    'The backend serves the API, the frontend is a static page that uses it, and the tests drive the whole thing end to end.',
    'Nothing about the interface is given: endpoints, payload shapes and field names are yours to agree on. Coordinate with',
    'the members who consume your part before you write it, and record binding choices as you go.',
    'Write only inside your own workspace. Node.js 24 is available with no third-party packages: use node: builtins only.',
  ].join(' '),
};

/** The single mid-run requirement change: tags gain a colour. */
export const changeNotice = {
  text: 'Requirement change: every tag must now carry a colour as a hex string like #3366cc. A tag posted without a' +
    ' colour must still come back with one. Update your own part of the application for this and keep the end-to-end' +
    ' tests consistent with the new shape.',
  field: 'color',
  affected: ['member:fe', 'member:be', 'member:qa'],
};
