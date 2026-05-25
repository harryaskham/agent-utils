# Android CLI extension

This package directory documents the Android helper extension exposed by `extensions/android.js`.

The extension provides tools for:

- diagnosing Android CLI availability;
- installing Android CLI with `curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash`;
- running Android CLI updates;
- capturing Android emulator/device screenshots through `adb exec-out screencap -p`;
- showing bounded screenshot streams through repeated adb captures.

See [`SKILL.md`](./SKILL.md) for agent-facing workflow guidance.
