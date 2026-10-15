#!/usr/bin/env node
import { forkSession, forkStatus, peer, retryFork } from '../extensions/lib/session-fork/core.js';
import { HELP, formatReceipt, parseArgs } from '../extensions/lib/session-fork/args.js';
import { MAX_WIRE, VERSION, fail } from '../extensions/lib/session-fork/io.js';

const args = process.argv.slice(2);
let peerMode = args[0] === '_peer';
const json = peerMode || args.includes('--json');
try {
  const parsed = parseArgs(args);
  let result;
  if (parsed.action === 'help') { process.stdout.write(HELP); }
  else {
    if (parsed.action === '_peer') {
      let length = 0; const chunks = [];
      const deadline = setTimeout(() => { process.stderr.write('Peer input deadline exceeded\n'); process.exit(2); }, 300000);
      try {
        for await (const chunk of process.stdin) {
          length += chunk.length;
          if (length > MAX_WIRE) fail('size', 'Peer request exceeds wire limit');
          chunks.push(chunk);
        }
        result = await peer(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } finally { clearTimeout(deadline); }
    } else if (parsed.action === 'fork') result = await forkSession(parsed.options);
    else if (parsed.action === 'retry') result = await retryFork(parsed.id);
    else result = await forkStatus(parsed.id, parsed.options);
    process.stdout.write(json ? `${JSON.stringify({ version: VERSION, ok: true, result })}\n` : `${formatReceipt(result)}\n`);
    if (!peerMode && result.status === 'indeterminate') process.exitCode = 3;
  }
} catch (error) {
  const envelope = { version: VERSION, ok: false, error: { code: error.code || 'error', message: error.message, details: error.details || {} } };
  if (json) process.stdout.write(`${JSON.stringify(envelope)}\n`);
  else process.stderr.write(`${envelope.error.code}: ${error.message}\n`);
  // The SSH peer always returns an envelope, including logical failures.
  process.exitCode = peerMode ? 0 : ['args', 'options', 'source', 'path', 'request-id'].includes(error.code) ? 2 : 1;
}
