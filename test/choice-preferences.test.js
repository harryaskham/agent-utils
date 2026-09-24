import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, lstat, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { choicePreferencesPath, createChoicePreferenceStore, readChoicePreferences, writeChoicePreferences } from "../extensions/lib/choice-preferences.js";

test("CHOICE-PREF-1 atomic local preference survives a new store and preserves managed symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "choice-pref-"));
  try {
    const env = { HOME: root, XDG_STATE_HOME: join(root, "state") };
    const path = choicePreferencesPath(env);
    assert.equal(path, join(root, "state/agent-utils/choice/ui.json"));
    const store = createChoicePreferenceStore({ env });
    assert.deepEqual(await store.load(), { expanded: null });
    await store.save(false);
    assert.deepEqual(await createChoicePreferenceStore({ env }).load(), { expanded: false });
    const a = store.save(true), b = store.save(false); await Promise.all([a, b]);
    assert.equal((await store.load()).expanded, false, "rapid toggles settle in submission order");
    await store.save(null);
    assert.deepEqual(await store.load(), { expanded: null });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "state/agent-utils/choice"))).mode & 0o777, 0o700);
    const link = join(root, "link.json");
    await symlink("state/agent-utils/choice/ui.json", link);
    const second = join(root, "second.json"); await symlink("link.json", second);
    await writeChoicePreferences(second, true);
    assert.ok((await lstat(link)).isSymbolicLink()); assert.ok((await lstat(second)).isSymbolicLink());
    assert.equal((await readChoicePreferences(path)).expanded, true);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, "utf8"))).sort(), ["expanded", "version"], "no prompt/choice/speech content persisted");
    await store.save(false, true);
    assert.deepEqual(await createChoicePreferenceStore({ env }).load(), { expanded: false, fullscreen: true });
    await store.save(true, false);
    assert.deepEqual(await store.load(), { expanded: true, fullscreen: false });
    await store.save(null, null);
    assert.deepEqual(await store.load(), { expanded: null, fullscreen: null });
    await writeFile(path, "bad sensitive input");
    await assert.rejects(readChoicePreferences(path), error => !error.message.includes("sensitive"));
    await writeFile(path, "x".repeat(4097));
    await assert.rejects(readChoicePreferences(path), /invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("incognito view preferences stay in memory even with a configured shared path", async () => {
  const root = await mkdtemp(join(tmpdir(), "choice-pref-private-"));
  try {
    const path = join(root, "ui.json");
    const store = createChoicePreferenceStore({ path, env: { PI_INCOGNITO: "1" } });
    assert.equal(store.persistent, false);
    await store.save(false); assert.equal((await store.load()).expanded, false);
    await assert.rejects(stat(path), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
