// Shared semantic input-action bus contract.
//
// Device adapters (keyboard, ring, future switches/controllers) publish actions
// without importing a consuming UI. Choice is one consumer today; future Pi
// controls can reuse the same bus or add new action names.

export const INPUT_ACTION_EVENT = "agent-utils:input-action";

export const INPUT_ACTIONS = Object.freeze({
  SELECT_PREVIOUS: "select-prev",
  SELECT_NEXT: "select-next",
  CHOOSE_CURRENT: "choose-current",
  CHOOSE_INDEX: "choose-index",
  CANCEL: "cancel",
});
