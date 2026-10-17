// Every shipped theme must load in Pi: since Pi 1.3 themes are validated
// strictly against https://pi.dev/schemas/theme.schema.json at startup, and
// one stray key (e.g. a custom `export` colour) makes Pi reject the theme
// ("Theme not found") and fall back to `system`. The schema is vendored in
// test/fixtures so this runs offline.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const themesDir = fileURLToPath(new URL("../themes/", import.meta.url));
const schema = JSON.parse(await readFile(fileURLToPath(new URL("./fixtures/pi-theme.schema.json", import.meta.url)), "utf8"));
const pkg = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

const isColorValue = (value) => (typeof value === "string") || (Number.isInteger(value) && value >= 0 && value <= 255);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FUNC = /^(?:oklch|okhsl)\(.*\)$/i;

function resolve(theme, value, seen = new Set()) {
  if (typeof value !== "string" || value === "" || HEX.test(value) || FUNC.test(value)) return value;
  assert.ok(theme.vars && value in theme.vars, `unknown variable reference ${JSON.stringify(value)}`);
  assert.ok(!seen.has(value), `circular variable reference through ${value}`);
  seen.add(value);
  return resolve(theme, theme.vars[value], seen);
}

const files = (await readdir(themesDir)).filter((name) => name.endsWith(".json")).sort();

test("package.json ships every theme in themes/", () => {
  assert.deepEqual([...pkg.pi.themes].map((path) => path.replace(/^\.\/themes\//, "")).sort(), files);
});

for (const file of files) {
  test(`themes/${file} passes Pi's strict theme schema`, async () => {
    const theme = JSON.parse(await readFile(`${themesDir}${file}`, "utf8"));
    const top = schema.properties;
    for (const key of Object.keys(theme)) assert.ok(key in top, `unsupported top-level key ${key}`);
    for (const key of schema.required) assert.ok(key in theme, `missing ${key}`);
    assert.equal(theme.$schema, "https://pi.dev/schemas/theme.schema.json");
    assert.equal(theme.name, file.replace(/\.json$/, ""));
    if ("appearance" in theme) assert.ok(["dark", "light"].includes(theme.appearance));
    for (const [name, value] of Object.entries(theme.vars || {})) assert.ok(isColorValue(value), `vars.${name}`);
    const colors = top.colors;
    for (const key of colors.required) assert.ok(key in theme.colors, `missing colors.${key}`);
    for (const [key, value] of Object.entries(theme.colors)) {
      assert.ok(key in colors.properties, `unsupported colors.${key}`);
      assert.ok(isColorValue(value), `colors.${key}`);
      resolve(theme, value);
    }
    for (const [key, value] of Object.entries(theme.export || {})) {
      assert.ok(key in top.export.properties, `unsupported export.${key} (Pi rejects the whole theme)`);
      resolve(theme, value);
    }
    for (const value of Object.values(theme.vars || {})) resolve(theme, value);
  });
}
