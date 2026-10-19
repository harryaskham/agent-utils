// Durable adaptor: /loop for pi-daemon sessions, a repeating prompt as a Durable background task.
//
// List this file in a pi-daemon profile's `extensions:`. It exports the extension-module
// contract's `extension` (the loop task) and `commands` (/loop); the behaviour lives in
// ../lib/durable-loop.js. It needs pi-daemon 1.10 or later (module commands get the session's
// Durable harness, and sessions with live background tasks are resumed at startup).
//
// Environment: PI_LOOP_MIN_INTERVAL_SECS (default 30), PI_LOOP_DEFAULT_DELIVERY (steer, else
// follow-up while busy), PI_LOOP_TZ (time zone of the delivered timestamp; default the worker's).
import { DEFAULT_MIN_INTERVAL_SECS, createLoopCommands, createLoopTask } from "../lib/durable-loop.js";

const minSecs = Number.parseInt(process.env.PI_LOOP_MIN_INTERVAL_SECS ?? "", 10);
const task = createLoopTask({ timeZone: process.env.PI_LOOP_TZ });

export const extension = { name: "agent-utils-loop", tasks: [task] };

export const commands = createLoopCommands({
  task,
  minSecs: Number.isFinite(minSecs) && minSecs > 0 ? minSecs : DEFAULT_MIN_INTERVAL_SECS,
  defaultDelivery: process.env.PI_LOOP_DEFAULT_DELIVERY === "steer" ? "steer" : "followUp",
});
