import test from "node:test";
import assert from "node:assert/strict";

import {
  isNoActiveResponseError,
  isReasoningRejectionError,
  isResponseBusyError,
  isSpeedRejectionError,
} from "../extensions/lib/realtime-response-errors.js";

test("isResponseBusyError matches the upstream busy-slot message", () => {
  // Upstream-verbatim string from a barge-in race (the report that motivated
  // the response-slot serialization).
  assert.equal(
    isResponseBusyError("Conversation already has an active response in progress: resp_E5V5JaYfYzrC04eAM3zP3"),
    true,
  );
  assert.equal(isResponseBusyError("conversation already has an active response"), true);
  assert.equal(isResponseBusyError("An active response is already pending"), true);
  assert.equal(isResponseBusyError("Invalid value: 'banana'"), false);
  assert.equal(isResponseBusyError(""), false);
  assert.equal(isResponseBusyError(undefined), false);
});

test("isNoActiveResponseError matches a cancel that raced response.done", () => {
  assert.equal(isNoActiveResponseError("Cancellation failed: no active response found"), true);
  assert.equal(isNoActiveResponseError("There is no active response to cancel"), true);
  assert.equal(isNoActiveResponseError("Conversation already has an active response in progress"), false);
});

test("reasoning/speed rejection classifiers cover reworded upstream errors", () => {
  assert.equal(isReasoningRejectionError("Unknown parameter: 'response.reasoning'"), true);
  assert.equal(isReasoningRejectionError("Unknown parameter: 'response.reasoning_effort'"), true);
  assert.equal(isReasoningRejectionError("response.reasoning is not supported for this model"), true);
  assert.equal(isReasoningRejectionError("Unrecognized request argument supplied: reasoning"), true);
  assert.equal(isReasoningRejectionError("Reasoning effort must be one of low, medium, high"), false, "a value complaint is not a rejection of the parameter itself");
  assert.equal(isReasoningRejectionError("Unknown parameter: 'response.speed'"), false);

  assert.equal(isSpeedRejectionError("Unknown parameter: 'response.speed'"), true);
  assert.equal(isSpeedRejectionError("Unknown parameter: 'speed'"), true);
  assert.equal(isSpeedRejectionError("speed is not supported"), true);
  assert.equal(isSpeedRejectionError("Conversation already has an active response in progress"), false);
});
