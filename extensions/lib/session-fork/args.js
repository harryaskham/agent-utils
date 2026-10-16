import { fail } from './io.js';
import { validateOptions } from './core.js';

export const HELP = `Fork a Pi session without rewriting history.

  pi-session fork --session <path|id> [options]
  pi-session pull --from HOST --session <source-path|id> [options]
  pi-session retry <request-id> [--json]
  pi-session status <request-id> [--remote HOST] [--json]

In Pi: /session-fork [options] | /session-fork retry|status <request-id>
Pull in Pi: /session-fork --from HOST --session <source-path|id> [options]

  --remote HOST          Push to this SSH destination (run on the source)
  --from HOST            Pull from this SSH source (run on the destination)
  --name NAME            New session name; defaults to source name/branch
  --worktree NAME        New detached worktree; defaults to session name
  --repo PATH            Destination main repo (default: HOME-relative source)
  --worktree-root PATH   Override destination worktree root
  --cwd PATH             Reuse an existing directory instead of making a worktree
  --clone                Allow cloning a missing destination repo from origin
  --dirty omit           Explicitly leave uncommitted/untracked work on source
  --herdr                Open workspace and start Pi through Herdr
  --herdr-session NAME   Explicit Herdr server session (default: default)
  --focus                Focus the fork after Herdr reports it ready
  --request ID           Stable retry key (generated and returned if omitted)
  --session-dir PATH     Destination Pi storage override
  --source-session-dir PATH  Source session lookup override
  --remote-command PATH  Executable on the SSH peer (default: pi-session)
  --dry-run              Resolve/validate the plan without creating a fork
  --json                 Machine-readable envelope
  --help                 Show this help

Both hosts need this CLI for SSH transfer; only the destination needs Pi to
resume. Pull never requires the source to SSH back. Source --session paths are
resolved there; all destination paths are resolved here for pull. No auth or
configuration is copied. Retries keep the same snapshot and session ID.
`;
const values = { session: 'session', remote: 'remote', from: 'from', name: 'name', worktree: 'worktree', repo: 'repo', 'worktree-root': 'worktreeRoot', cwd: 'cwd', dirty: 'dirty', 'herdr-session': 'herdrSession', request: 'request', 'session-dir': 'sessionDir', 'source-session-dir': 'sourceSessionDir', 'remote-command': 'remoteCommand' };
const booleans = { clone: 'clone', herdr: 'herdr', focus: 'focus', 'dry-run': 'dryRun', json: 'json', help: 'help' };
// Deliberately not a shell: no expansion, command substitution, or evaluation.
export function tokenize(text) {
  const tokens = []; let token = ''; let quote = null; let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && ['"', '\\'].includes(text[i + 1])) token += text[++i];
      else token += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { tokens.push(token); token = ''; started = false; } }
    else if (c === '\\') { if (++i === text.length) fail('args', 'Trailing escape'); token += text[i]; started = true; }
    else { token += c; started = true; }
  }
  if (quote) fail('args', 'Unclosed quote');
  if (started) tokens.push(token);
  return tokens;
}
export function parseArgs(input, { extension = false } = {}) {
  const args = Array.isArray(input) ? [...input] : tokenize(input);
  let action = extension ? 'fork' : args.shift() || 'help';
  if (extension && ['fork', 'pull', 'retry', 'status', 'help'].includes(args[0])) action = args.shift();
  if (action === '--help' || action === '-h') action = 'help';
  if (!['fork', 'pull', 'retry', 'status', 'help', '_peer'].includes(action)) fail('args', `Unknown command: ${action}`);
  const options = {}; let id;
  if (['retry', 'status'].includes(action)) id = args.shift();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-h') { options.help = true; continue; }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(args[i]);
    if (!match) fail('args', `Expected an option, got: ${args[i]}`);
    const [, key, inline] = match;
    if (values[key]) {
      const value = inline ?? args[++i];
      if (value === undefined || value === '' || value.startsWith('--')) fail('args', `--${key} needs a value`);
      if (values[key] in options) fail('args', `Repeated --${key}`);
      options[values[key]] = value;
    } else if (booleans[key] && inline === undefined) options[booleans[key]] = true;
    else fail('args', `Unknown option: --${key}`);
  }
  if (options.help) return { action: 'help', options };
  if (['retry', 'status'].includes(action)) {
    if (!id || id.startsWith('-')) fail('args', `${action} requires a request ID`);
    const allowed = action === 'status' ? ['json', 'remote', 'remoteCommand'] : ['json'];
    for (const key of Object.keys(options)) if (!allowed.includes(key)) fail('args', `${action} does not accept ${key}`);
  }
  if (action === 'pull') {
    if (!options.from) fail('args', 'pull requires --from <source-host>');
    action = 'fork'; // One domain action; `fork --from` is the same operation.
  }
  if (extension && options.session && !options.from) fail('args', 'The Pi command forks its active session; use --from for a remote source or the CLI for another local session');
  validateOptions(options);
  return { action, options, id };
}
export function formatReceipt(r) {
  if (r.status === 'planned') return `Plan: ${r.name}\nDestination: ${r.destination.host}:${r.destination.cwd}\nGit objects: ${r.transferGitObjects ? 'transfer required' : 'already available'}\nNo changes made.`;
  const lines = [`Fork ${r.requestId}: ${r.status}`];
  if (r.direction === 'pull') lines.push(`Pull source: ${r.sourceHost}`);
  if (r.error) lines.push(`${r.error.code}: ${r.error.message}`);
  if (r.sessionId) lines.push(`Session: ${r.sessionId}`, `Destination: ${r.destination.host}:${r.cwd}`, `Resume there: ${r.resume.onDestination}`);
  if (r.herdr) lines.push(`Herdr: ${r.herdr.status}${r.herdr.paneId ? ` (${r.herdr.session}/${r.herdr.paneId})` : ''}${r.herdr.error ? ` — ${r.herdr.error}` : ''}`);
  for (const warning of r.warnings || []) lines.push(`Warning: ${warning}`);
  if (r.status !== 'missing') lines.push(`Status: pi-session status ${r.requestId}`);
  return lines.join('\n');
}
