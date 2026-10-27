// Which Cacophony project a visiting registration belongs to when the operator names none, or
// names one the checkout cannot be. Cacophony decides from the checkout's git remotes: a
// remote matching exactly one configured project names it (several are settled by branch);
// remotes matching nothing, or a directory without remotes, never name one here.

const CONFLICT = /conflicts with caller checkout git remotes; matching configured projects: (.+?)\. Pass --project/;

/**
 * The only configured project a refused request could have meant, from caco's refusal
 * ("visiting project 'x' conflicts with caller checkout git remotes; matching configured
 * projects: y. …"). Null unless exactly one project is listed.
 */
export function soleConflictCandidate(message) {
  const match = CONFLICT.exec(String(message || ""));
  const names = match ? match[1].split(",").map((name) => name.trim()).filter(Boolean) : [];
  return names.length === 1 ? names[0] : null;
}

/**
 * Ask caco which configured project the checkout at `cwd` belongs to, by its git remotes.
 * `--preview` registers nothing and issues no credentials; an explicit `--checkout-root`
 * never inherits a project from the environment. `run(args)` executes caco and resolves its
 * JSON (rejecting with caco's message, which lists candidates when several match).
 */
export async function inferVisitingProject({ run, cwd, sessionId }) {
  if (!cwd) throw new Error("the session's directory is unknown, so no project can be inferred; use /caco-agent-register project=<name>");
  const response = await run(["agent", "register", "--preview", "--checkout-root", cwd, "--session-id", sessionId, "--json"]);
  const data = response?.data || response;
  const project = String(data?.project || "").trim();
  if (!project || data?.project_source !== "cwd git remote") {
    throw new Error(`no configured Cacophony project matches the git remotes of ${cwd}; use /caco-agent-register project=<name>`);
  }
  return project;
}

/**
 * Register with `requested`, inferring it when absent, and retrying once with the sole
 * matching project when caco refuses `requested` for this checkout. `attempt(project)`
 * registers; the note says why the project differs from what was asked, if it does.
 */
export async function registerInferringProject({ requested, infer, attempt }) {
  let project = String(requested || "").trim();
  let note = "";
  if (!project) {
    project = await infer();
    note = "inferred from this checkout's git remotes";
  }
  try {
    return { result: await attempt(project), project, note };
  } catch (error) {
    const sole = soleConflictCandidate(error?.message);
    if (!sole || sole === project) throw error;
    const result = await attempt(sole);
    return { result, project: sole, note: `${project} does not match this checkout's git remotes; ${sole} is the only configured project they match` };
  }
}
