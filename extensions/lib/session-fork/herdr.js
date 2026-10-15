import { join } from 'node:path';
import { hash, readJson, run, writeJson } from './io.js';
import { slug } from './git.js';

// Herdr owns presentation only. Its create/start API has no idempotency key:
// durably record admission, and never repeat an ambiguous mutation.
export async function openHerdr(request, receipt, dir, execute = run) {
  const path = join(dir, 'herdr.json');
  let state = await readJson(path).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const session = request.options.herdrSession || 'default';
  const command = async args => {
    const response = await execute('herdr', ['--session', session, ...args], { timeout: 45000 });
    const parsed = JSON.parse(response.stdout);
    if (!parsed.result) throw new Error('Herdr did not return a result');
    return parsed.result;
  };
  const save = async () => writeJson(path, state, { replace: true });
  if (state && ['opening', 'starting', 'indeterminate'].includes(state.status)) {
    return { ...state, status: 'indeterminate', message: 'A previous Herdr action may have completed. Inspect the recorded workspace/pane; no create/start was replayed.' };
  }
  try {
    if (!state) {
      state = { status: 'opening', session, agentName: `fork-${slug(request.name).slice(0, 16)}-${hash(request.id).slice(0, 8)}` };
      await save();
      const args = receipt.destination.makeWorktree
        ? ['worktree', 'open', '--cwd', receipt.destination.repo, '--path', receipt.cwd]
        : ['workspace', 'create', '--cwd', receipt.cwd];
      const result = await command([...args, '--label', request.name, '--no-focus']);
      if (!result.workspace?.workspace_id || !result.root_pane?.pane_id) throw new Error('Herdr create/open response lacks workspace/root_pane IDs');
      state = { ...state, status: 'workspace_ready', workspaceId: result.workspace.workspace_id, paneId: result.root_pane.pane_id };
      await save();
    }
    if (state.status === 'workspace_ready') {
      state.status = 'starting'; await save();
      const started = await command(['agent', 'start', state.agentName, '--kind', 'pi', '--pane', state.paneId, '--timeout', '30000', '--', '--session', receipt.sessionFile, '--name', request.name]);
      if (started.agent?.pane_id !== state.paneId || !started.agent?.terminal_id) throw new Error('Herdr start did not identify the expected terminal');
      state.terminalId = started.agent.terminal_id;
      state.status = 'ready'; await save();
    }
    if (request.options.focus && !state.focused) {
      const current = (await command(['agent', 'get', state.agentName])).agent;
      // Native session IDs are optional in Herdr 0.9. Its live name is bound to
      // the current occupant and cleared on exit/replacement; also check the
      // saved terminal identity, not just a workspace-qualified pane handle.
      if (current?.name !== state.agentName || current?.pane_id !== state.paneId || current?.terminal_id !== state.terminalId || current?.agent !== 'pi' ||
          (current.agent_session && ![receipt.sessionFile, receipt.sessionId].includes(current.agent_session.value))) {
        throw new Error('Herdr agent identity changed or is not verified; refusing to focus a possibly reused pane');
      }
      await command(['agent', 'focus', state.agentName]);
      state.focused = true; delete state.error; await save();
    }
    return state;
  } catch (e) {
    // No duplicate launch even if the peer acted before our timeout/disconnect.
    if (state.status !== 'ready') state.status = 'indeterminate';
    state.error = String(e.message || e).slice(0, 2000);
    await save();
    return state;
  }
}
