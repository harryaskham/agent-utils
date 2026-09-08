import test from 'node:test';
import assert from 'node:assert/strict';
import register from '../extensions/herdr-input-state.js';

function harness() {
  const handlers = new Map(), events = [];
  register({ on: (key, fn) => handlers.set(key, fn), events: { emit: (key, data) => events.push({ key, data }) } });
  return { handlers, events };
}
test('standard Pi prompts report one balanced Herdr blocked interval', () => {
  const { handlers: h, events } = harness();
  h.get('ui_prompt_start')({ title: 'Choose next action' }, { mode: 'tui' });
  h.get('ui_prompt_start')({}, { mode: 'tui' });
  assert.deepEqual(events, [{ key: 'herdr:blocked', data: { active: true, label: 'Choose next action' } }]);
  h.get('ui_prompt_end')();
  h.get('session_shutdown')();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1].data, { active: false });
});
test('shutdown releases an outstanding prompt; headless prompts are ignored', () => {
  const { handlers: h, events } = harness();
  h.get('ui_prompt_start')({}, { mode: 'rpc' });
  assert.equal(events.length, 0);
  h.get('ui_prompt_start')({}, { mode: 'tui' });
  h.get('session_shutdown')();
  assert.deepEqual(events.map(e => e.data.active), [true, false]);
});
