# Android CLI Pi workflow

Use this skill when the user wants Android CLI setup, emulator screenshots, or a short emulator visual stream inside Pi.

## Tools

- `android_cli_doctor` — check `android`, `adb`, `emulator`, `sdkmanager`, `ANDROID_HOME` / `ANDROID_SDK_ROOT`, and print usage.
- `android_cli_install` — installs Android CLI using:
  `curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash`
  Run with `confirmed: true` only after the user explicitly wants installation.
- `android_cli_update` — runs `android update`, or `sdkmanager --update` if `android` is unavailable. Requires `confirmed: true`.
- `android_emulator_screenshot` — runs `adb exec-out screencap -p`, saves a PNG, and returns image content so Pi can show it immediately. The saved path can also be passed to `kitty_image_preview_add`.
- `android_emulator_stream` — bounded stream implemented as repeated `adb exec-out screencap -p` captures. It sends image updates while it runs and returns the latest PNG path.

## Common one-shot flows

1. Diagnose setup:
   - call `android_cli_doctor`.
2. Install if missing:
   - call `android_cli_install` with `confirmed: true`.
3. Update packages:
   - call `android_cli_update` with `confirmed: true`.
4. Show emulator screenshot:
   - call `android_emulator_screenshot` with optional `serial`, default `preview: true`.
5. Show a short stream:
   - call `android_emulator_stream` with `frames` and `intervalMs`.

If multiple devices are connected, pass `serial`, for example `emulator-5554`.
