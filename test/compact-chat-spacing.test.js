import test from "node:test";
import assert from "node:assert/strict";

import { installCompactChatSpacingPatch } from "../extensions/pi-graphics/compact-chat-spacing.js";

test("compact chat spacing drops only spacers between adjacent chat bubbles", () => {
  class BaseContainer {
    constructor() { this.children = []; }
    addChild(component) { this.children.push(component); }
  }
  class UserBubble extends BaseContainer {}
  class AssistantBubble extends BaseContainer {}
  class Spacer { constructor(rows = 1) { this.rows = rows; } }
  class StatusLine {}

  const patch = installCompactChatSpacingPatch({
    basePrototype: BaseContainer.prototype,
    chatBubbleConstructors: [UserBubble, AssistantBubble],
  });
  assert.equal(patch.installed, true);

  const compact = new BaseContainer();
  const user = new UserBubble();
  const spacer = new Spacer(1);
  const assistant = new AssistantBubble();
  compact.addChild(user);
  compact.addChild(spacer);
  compact.addChild(assistant);
  assert.deepEqual(compact.children, [user, assistant], "spacer between chat bubbles should be elided");

  const preserved = new BaseContainer();
  const status = new StatusLine();
  const statusSpacer = new Spacer(1);
  preserved.addChild(user);
  preserved.addChild(statusSpacer);
  preserved.addChild(status);
  assert.deepEqual(preserved.children, [user, statusSpacer, status], "spacer before non-bubble content should be preserved");

  patch.restore();
});

test("compact chat spacing preserves a trailing spacer at render time", () => {
  class BaseContainer {
    constructor() { this.children = []; }
    addChild(component) { this.children.push(component); }
    clear() { this.children = []; }
    render() { return this.children.map((child) => child.constructor.name); }
  }
  class Bubble extends BaseContainer {}
  class Spacer {}

  const patch = installCompactChatSpacingPatch({ basePrototype: BaseContainer.prototype, chatBubbleConstructors: [Bubble] });
  const parent = new BaseContainer();
  const bubble = new Bubble();
  const trailing = new Spacer();
  parent.addChild(bubble);
  parent.addChild(trailing);

  assert.deepEqual(parent.children, [bubble], "trailing spacer can be held pending until the final component is known");
  assert.deepEqual(parent.render(), ["Bubble", "Spacer"], "render should flush a trailing spacer that was not followed by another bubble");
  assert.deepEqual(parent.children, [bubble, trailing]);

  parent.addChild(new Spacer());
  parent.clear();
  assert.deepEqual(parent.render(), [], "clear should discard any held pending spacer");

  patch.restore();
});

test("compact chat spacing patch is idempotent per container prototype", () => {
  class BaseContainer {
    constructor() { this.children = []; }
    addChild(component) { this.children.push(component); }
  }
  class Bubble extends BaseContainer {}
  class Spacer {}

  const first = installCompactChatSpacingPatch({ basePrototype: BaseContainer.prototype, chatBubbleConstructors: [Bubble] });
  const second = installCompactChatSpacingPatch({ basePrototype: BaseContainer.prototype, chatBubbleConstructors: [Bubble] });
  assert.equal(first.installed, true);
  assert.equal(second.alreadyInstalled, true);

  const parent = new BaseContainer();
  const a = new Bubble();
  const b = new Bubble();
  parent.addChild(a);
  parent.addChild(new Spacer());
  parent.addChild(b);
  assert.deepEqual(parent.children, [a, b], "idempotent patch should not double-wrap addChild");

  first.restore();
});
