// Durable adaptor: /loop for pi-daemon sessions, a repeating prompt as a Durable background task.
// Commands as the TUI /loop: /loop <interval> [--steer] <prompt> (several at once, numbered),
// /loop list (or /loops), /loop stop [id|all] (off and end too); the agent manages its own loops
// with the TUI's tools, create_loop, list_loops and stop_loop, sharing the same numbers.
//
// List this file in a pi-daemon profile's `extensions:`. It exports the extension-module
// contract's `extension` (the loop task) and `commands` (/loop); the behaviour lives in
// ../lib/durable-loop.js. It needs pi-daemon 1.10 or later (module commands get the session's
// Durable harness, and sessions with live background tasks are resumed at startup).
//
// Environment: PI_LOOP_MIN_INTERVAL_SECS (default 30), PI_LOOP_DEFAULT_DELIVERY (steer, else
// follow-up while busy), PI_LOOP_TZ (time zone of the delivered timestamp; default the worker's).
import { DEFAULT_MIN_INTERVAL_SECS, createLoopCommands, createLoopTask, createLoopTools } from "../lib/durable-loop.js";

const minSecs = Number.parseInt(process.env.PI_LOOP_MIN_INTERVAL_SECS ?? "", 10);
const task = createLoopTask({ timeZone: process.env.PI_LOOP_TZ });

const options = {
  task,
  minSecs: Number.isFinite(minSecs) && minSecs > 0 ? minSecs : DEFAULT_MIN_INTERVAL_SECS,
  defaultDelivery: process.env.PI_LOOP_DEFAULT_DELIVERY === "steer" ? "steer" : "followUp",
};

// The loop task, and the agent's own tools: create_loop, list_loops, stop_loop.
export const extension = { name: "agent-utils-loop", tasks: [task], tools: createLoopTools(options) };

// /loop and /loops.
export const commands = createLoopCommands(options);
