// Choices for pi-daemon sessions (bd-ac1906), after agent-utils' TUI choice.js: interactive_choice
// (blocking) and async_choice (non-blocking, answered whenever: pi-client's /choices, the web
// view, AHP clients), with async_choice_status and async_choice_cancel. Questions are
// pi-daemon's (needs pi-daemon 1.13): they survive restarts and need no client open.
// See lib/durable-choice.js.
import { createAsyncChoiceTask, createChoiceTools } from "../lib/durable-choice.js";

const asyncTask = createAsyncChoiceTask();

export const extension = { name: "agent-utils-choice", tasks: [asyncTask], tools: createChoiceTools({ asyncTask }) };
