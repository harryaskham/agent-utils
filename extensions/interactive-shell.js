// Interactive shell extension for Pi.
// Launches full-terminal programs inside Pi's TUI overlay with keyboard passthrough.
// Useful for nix repl, cltv repl, htop, git log --oneline --graph, lazygit, etc.
//
// Commands:
//   /shell <command>    — launch an interactive program in a Pi overlay
//   /shell              — launch $SHELL (default bash)
//
// Tool:
//   interactive_shell   — LLM-callable tool to launch interactive programs
//
// The overlay captures all keyboard input and forwards it to the child process.
// Press Ctrl+] (GS, 0x1d) to detach and return to Pi.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// --- Constants ---

const DETACH_KEY = "\x1d"; // Ctrl+]
const DETACH_LABEL = "Ctrl+]";
const MAX_SCROLLBACK = 2000;
const DEFAULT_SHELL = process.env.SHELL || "/bin/bash";

// Curated presets for common interactive programs
const PRESETS = {
  "nix-repl": { cmd: "nix", args: ["repl"], label: "Nix REPL", pty: true },
  "cltv-repl": {
    cmd: "cltv",
    args: ["repl", "--flake"],
    label: "Collective REPL",
    pty: true,
  },
  htop: { cmd: "htop", args: [], label: "htop", pty: true },
  lazygit: { cmd: "lazygit", args: [], label: "lazygit", pty: true },
  "git-log": {
    cmd: "git",
    args: ["log", "--oneline", "--graph", "--all", "-30"],
    label: "git log",
    pty: true,
  },
  bash: { cmd: "bash", args: ["-l"], label: "Bash", pty: true },
  zsh: { cmd: "zsh", args: ["-l"], label: "Zsh", pty: true },
};

// --- PTY wrapper ---
// Since node-pty is not available, Linux uses util-linux script(1). BSD script
// requires its own controlling terminal and therefore cannot bridge Node pipes;
// Darwin uses our tiny standard-library Python PTY bridge instead.

const PTY_BRIDGE_PATH = fileURLToPath(new URL("../scripts/pty-bridge.py", import.meta.url));

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildSpawnArgs(command, args = [], cols, rows, platform = process.platform, env = process.env) {
  const darwin = platform === "darwin";
  return {
    cmd: darwin ? (env.PYTHON || "python3") : "script",
    args: darwin
      ? [PTY_BRIDGE_PATH, command, ...args]
      : ["-qfc", [command, ...args].map(shellQuote).join(" "), "/dev/null"],
    env: {
      ...env,
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
    },
  };
}

// --- Terminal output buffer ---
// Maintains a scrollback of terminal lines from raw ANSI output.

class TerminalBuffer {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.lines = [];
    this.currentLine = "";
    this.exited = false;
    this.exitCode = null;
  }

  write(data) {
    const text = typeof data === "string" ? data : data.toString("utf-8");

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\n") {
        this.lines.push(this.currentLine);
        this.currentLine = "";
        if (this.lines.length > MAX_SCROLLBACK) {
          this.lines.shift();
        }
      } else if (ch === "\r") {
        this.currentLine = "";
      } else {
        this.currentLine += ch;
      }
    }
  }

  getVisibleLines(height) {
    const allLines = [...this.lines];
    if (this.currentLine.length > 0) {
      allLines.push(this.currentLine);
    }

    // Return the last `height` lines (bottom of scrollback)
    const start = Math.max(0, allLines.length - height);
    return allLines.slice(start, start + height);
  }

  markExited(code) {
    this.exited = true;
    this.exitCode = code;
  }
}

// --- Shell overlay component ---
// A Pi TUI component that renders terminal output and handles keyboard input.

class ShellComponent {
  constructor(child, buffer, label, done) {
    this.child = child;
    this.buffer = buffer;
    this.label = label;
    this.done = done;
    this._disposed = false;
  }

  render(width) {
    const termHeight = process.stdout.rows || 24;
    // Reserve 2 lines for header/footer chrome
    const contentHeight = Math.max(4, termHeight - 4);

    const header = `\x1b[1;36m── ${this.label} ──\x1b[0m\x1b[2m  (${DETACH_LABEL} to detach)\x1b[0m`;

    const visibleLines = this.buffer.getVisibleLines(contentHeight);

    // Pad to fill the viewport so the overlay doesn't jump around
    const padded = [];
    for (let i = 0; i < contentHeight; i++) {
      padded.push(visibleLines[i] !== undefined ? visibleLines[i] : "");
    }

    const footer = this.buffer.exited
      ? `\x1b[2m── exited (${this.buffer.exitCode ?? "?"}) ── press any key ──\x1b[0m`
      : `\x1b[2m── ${DETACH_LABEL}: detach | input forwarded to process ──\x1b[0m`;

    return [header, ...padded, footer];
  }

  handleInput(data) {
    if (this._disposed) return;

    // Ctrl+] detaches
    if (data === DETACH_KEY) {
      this._cleanup("detached");
      return;
    }

    // If process has exited, any key dismisses
    if (this.buffer.exited) {
      this._cleanup("exited");
      return;
    }

    // Forward all input to the child process
    try {
      if (this.child.stdin && !this.child.stdin.destroyed) {
        this.child.stdin.write(data);
      }
    } catch {
      // Process may have died between check and write
    }
  }

  invalidate() {
    // No cache to clear
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;

    // Kill the child if still running
    try {
      if (!this.child.killed) {
        this.child.kill("SIGTERM");
        // Force kill after 2s
        setTimeout(() => {
          try {
            if (!this.child.killed) this.child.kill("SIGKILL");
          } catch {
            // already dead
          }
        }, 2000);
      }
    } catch {
      // already dead
    }
  }

  _cleanup(reason) {
    this._disposed = true;

    // Kill if still alive
    try {
      if (!this.child.killed) {
        this.child.kill("SIGTERM");
      }
    } catch {
      // ok
    }

    this.done({ reason, exitCode: this.buffer.exitCode });
  }
}

// --- Launch logic ---

async function launchShell(ctx, label, command, args) {
  const cols = process.stdout.columns || 120;
  const rows = process.stdout.rows || 24;

  const spawnOpts = buildSpawnArgs(command, args, cols, rows - 4);

  const child = spawn(spawnOpts.cmd, spawnOpts.args, {
    env: spawnOpts.env,
    cwd: ctx.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const buffer = new TerminalBuffer(cols, rows - 4);

  // Pipe stdout/stderr into the buffer
  if (child.stdout) {
    child.stdout.on("data", (data) => {
      buffer.write(data);
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (data) => {
      buffer.write(data);
    });
  }

  child.on("exit", (code) => {
    buffer.markExited(code);
  });

  child.on("error", (err) => {
    buffer.write(`\n[error: ${err.message}]\n`);
    buffer.markExited(1);
  });

  // Show the overlay and wait for the user to detach or the process to end
  const result = await ctx.ui.custom(
    (_tui, _theme, _keybindings, done) => {
      const component = new ShellComponent(child, buffer, label, done);

      // Re-render periodically while process is alive so output appears
      const renderInterval = setInterval(() => {
        if (component._disposed) {
          clearInterval(renderInterval);
          return;
        }
        component.invalidate();
        // Trigger TUI redraw by invalidating
        _tui.requestRender();
      }, 50);

      // Auto-dismiss after process exits (give user a moment to see output)
      child.on("exit", () => {
        // The component will show "exited" footer; user presses any key to dismiss
      });

      return component;
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "center",
      },
    },
  );

  return result;
}

// --- Resolve command from user input ---

function resolveCommand(input) {
  const trimmed = input.trim();

  if (!trimmed) {
    return {
      cmd: DEFAULT_SHELL,
      args: ["-l"],
      label: DEFAULT_SHELL.split("/").pop(),
    };
  }

  // Check presets
  const preset = PRESETS[trimmed];
  if (preset) {
    return { cmd: preset.cmd, args: preset.args, label: preset.label };
  }

  // Parse as a shell command
  // Simple tokenization: split on whitespace, respecting single/double quotes
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    return {
      cmd: DEFAULT_SHELL,
      args: ["-l"],
      label: DEFAULT_SHELL.split("/").pop(),
    };
  }

  return {
    cmd: tokens[0],
    args: tokens.slice(1),
    label: trimmed.length > 40 ? trimmed.slice(0, 37) + "..." : trimmed,
  };
}

function tokenize(input) {
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (const ch of input) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === " " && !inSingle && !inDouble) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (current) tokens.push(current);
  return tokens;
}

// --- Extension entry point ---

export default function interactiveShellExtension(pi) {
  // /shell command
  pi.registerCommand("shell", {
    description: `Launch an interactive program in a Pi overlay. Usage: /shell [command|preset]. Presets: ${Object.keys(PRESETS).join(", ")}. ${DETACH_LABEL} to detach.`,
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "Interactive shell requires interactive mode.",
          "warning",
        );
        return;
      }

      const resolved = resolveCommand(args);

      ctx.ui.notify(`Launching: ${resolved.label}...`, "info");

      try {
        const result = await launchShell(
          ctx,
          resolved.label,
          resolved.cmd,
          resolved.args,
        );
        ctx.ui.notify(
          `Shell closed (${result?.reason || "unknown"}, exit: ${result?.exitCode ?? "?"})`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(`Shell error: ${err.message}`, "error");
      }
    },
    getArgumentCompletions: (prefix) => {
      const options = Object.keys(PRESETS);
      return options
        .filter((o) => o.startsWith(prefix))
        .map((o) => ({
          label: `${o} — ${PRESETS[o].label}`,
          value: o,
        }));
    },
  });

  // interactive_shell tool for LLM use
  pi.registerTool({
    name: "interactive_shell",
    label: "Interactive Shell",
    description:
      "Launch an interactive terminal program inside Pi's TUI. The user can interact with the program directly. Useful for nix repl, cltv repl, htop, lazygit, git log, or any interactive CLI tool. The user detaches with Ctrl+].",
    promptSnippet:
      "Launch interactive terminal programs (nix repl, htop, lazygit, etc.) inside Pi for the user to interact with directly.",
    promptGuidelines: [
      "Use this when the user needs to interact with a program directly, not when you need command output.",
      "Prefer preset names when available: nix-repl, cltv-repl, htop, lazygit, git-log.",
      "The user controls the program — you cannot see its output or interact with it.",
      "After the user detaches, the tool returns the exit status.",
    ],
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'Command to run, or a preset name. Presets: nix-repl, cltv-repl, htop, lazygit, git-log. Or any command like "python3" or "bash".',
        },
        args: {
          type: "array",
          items: { type: "string" },
          description:
            "Arguments to pass to the command. Ignored when using a preset name.",
        },
        label: {
          type: "string",
          description:
            "Display label for the overlay header. Auto-generated if omitted.",
        },
      },
      required: ["command"],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Interactive shell requires Pi interactive mode (TUI). Cannot launch in headless/RPC mode.",
            },
          ],
          isError: true,
        };
      }

      // Resolve command
      let cmd, args, label;
      const preset = PRESETS[params.command];
      if (preset) {
        cmd = preset.cmd;
        args = preset.args;
        label = params.label || preset.label;
      } else {
        cmd = params.command;
        args = params.args || [];
        label =
          params.label || [cmd, ...args].join(" ").slice(0, 40) || "Shell";
      }

      try {
        const result = await launchShell(ctx, label, cmd, args);
        return {
          content: [
            {
              type: "text",
              text: `Interactive shell "${label}" closed. Reason: ${result?.reason || "unknown"}. Exit code: ${result?.exitCode ?? "unknown"}.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to launch interactive shell: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },
  });

}
