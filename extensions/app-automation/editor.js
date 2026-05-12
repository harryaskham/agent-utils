import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function escapeJsString(value) {
  return JSON.stringify(String(value ?? ""));
}

export function buildEditorReplaceScript({ selector, text }) {
  return `(() => {
  const selector = ${escapeJsString(selector)};
  const text = ${escapeJsString(text)};
  const element = document.querySelector(selector);
  if (!element) return { ok: false, error: 'target selector not found', selector };
  element.focus();
  if ('value' in element) {
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    element.textContent = text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
  return { ok: true, selector, length: text.length };
})()`;
}

export async function prepareEditorReplace({ step = {}, params = {}, snapshotDir }) {
  const selector = step.selector || params.targetSelector;
  if (!selector) return { executable: false, reason: "editor.replace requires selector or targetSelector" };
  const inputPath = step.inputPath || params.pastePath || path.join(snapshotDir, "paste.txt");
  const text = await readFile(inputPath, "utf8");
  const script = buildEditorReplaceScript({ selector, text });
  const scriptPath = path.join(snapshotDir, "editor-replace.js");
  const outputPath = path.join(snapshotDir, "editor-replace-result.json");
  await writeFile(scriptPath, `${script}\n`, "utf8");
  return { executable: true, scriptPath, outputPath, selector, inputPath, textLength: text.length };
}
