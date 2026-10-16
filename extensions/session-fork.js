// Thin Pi adapter; all policy, Git, transport and persistence live in the CLI core.
import { forkSession, forkStatus, retryFork } from './lib/session-fork/core.js';
import { HELP, formatReceipt, parseArgs } from './lib/session-fork/args.js';

export default function sessionFork(pi) {
  pi.registerCommand('session-fork', {
    description: 'Fork unchanged history here, push over SSH, or pull with --from; optionally open in Herdr',
    handler: async (args, ctx) => {
      try {
        const { action, options, id } = parseArgs(args, { extension: true });
        if (action === 'help') { ctx.ui.notify(HELP, 'info'); return; }
        let result;
        if (action === 'status') result = await forkStatus(id, options);
        else if (action === 'retry') result = await retryFork(id);
        else if (options.from) {
          // Pull is destination-side: do not substitute this Pi's identity or
          // require a saved local conversation. The source reads its JSONL.
          result = await forkSession(options, { sourceCwd: ctx.cwd });
        } else {
          // A slash command can run during streaming. Snapshot only finalized,
          // saved history and the actual selected branch, never a partial turn.
          await ctx.waitForIdle();
          const session = ctx.sessionManager.getSessionFile();
          if (!session) throw new Error('Cannot fork an in-memory session; save a conversation first');
          result = await forkSession({ ...options, session, runtimeCwd: true }, { sourceCwd: ctx.cwd, leafId: ctx.sessionManager.getLeafId() });
        }
        ctx.ui.notify(formatReceipt(result), result.status === 'indeterminate' ? 'warning' : 'info');
      } catch (e) { ctx.ui.notify(`Session fork failed: ${e.message}`, 'error'); }
    },
  });
}
