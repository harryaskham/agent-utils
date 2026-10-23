// pi-git's signal on Pi's event bus, between its client part (git-client.js: each session's git
// state as git.mjs reads it on the session's host) and its consumers (the editor chips' branch
// and diff, per pane), as the loops chip's.
//   GIT_EVENT { sessionId, workspace }: a session's git state (durable-git.js readWorkspace,
//     with `at`, and `failedAt`/`error` when the last refresh failed).
//   GIT_REQUEST { sessionId }: a consumer drawing that session asks for it.
export const GIT_EVENT = "agent-utils:git.v1";
export const GIT_REQUEST = "agent-utils:git-request.v1";
/** git.mjs's per-session state: pi-daemon's module state document, keyed by the module's name. */
export const GIT_STATE_DOC = { kind: "pi-daemon.module-state", version: 1, scope: "session", key: "git" };
