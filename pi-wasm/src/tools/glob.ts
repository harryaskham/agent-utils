// Minimal glob → RegExp for the browser grep/find tools (pi-wasm S4). Supports
// `**` (any depth incl. `/`), `*` (any chars except `/`), `?` (single non-`/`),
// and literal characters. No node deps, no external glob library.

export function globToRegExp(glob: string, options?: { ignoreCase?: boolean }): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // consume the `/` after `**`
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("+.^$()[]{}|\\/".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", options?.ignoreCase ? "i" : "");
}

export function matchesGlob(glob: string, candidate: string, options?: { ignoreCase?: boolean }): boolean {
  return globToRegExp(glob, options).test(candidate);
}
