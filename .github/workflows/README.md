# GitHub Actions workflows

This directory holds the repo's CI/Pages workflows. Actions only reads
`*.yml` / `*.yaml` here; this `README.md` is ignored by Actions.

## Where CI runs + how main stays green

CI runs on the **azure-ephemeral** self-hosted runner pool (`runs-on:
[self-hosted, azure-ephemeral]`): scale-to-zero, one ephemeral container per
queued job, ~30-90s cold start. These runners have Nix but no preinstalled
language toolchains, so jobs enter the repo dev shell (`nix develop --command
...`) for node/cargo/cargo-audit. They also have no secrets and no tailnet, so
the suite is kept hermetic and needs neither.

Dev reintegrations land via **PR auto-merge**: GitHub CI (the `js` / `rust` /
`audit` jobs) is the gate that keeps `main` green, not a local pre-merge gate.
Open the PR, let the checks pass, and it auto-merges.

## Validating workflows before you push (bd-ce9baf)

Workflow syntax/structure errors used to only surface after a push because no
local validator was wired in. Now there is one:

```bash
npm run lint:workflows
```

This is also part of `npm run check` (and therefore runs in the `js` CI job), so
a malformed workflow fails fast. The linter picks the strongest validator
available, in priority order:

1. **`actionlint`** — full Actions-specific semantic + syntax checks. It is
   provided by the Nix dev shell (`nix develop`), which adds `pkgs.actionlint`
   to `PATH`. Install it standalone with `nix profile install nixpkgs#actionlint`
   or see <https://github.com/rhysd/actionlint> for other options.
2. **`ruby -ryaml`** — YAML well-formedness. System ruby is reliably present on
   macOS and on `ubuntu-latest` GitHub runners, so this is the dependable
   fallback when `actionlint` is not installed.
3. **`python3` + PyYAML** — YAML well-formedness, if available.

If none of these is available, `npm run lint:workflows` prints a warning and
exits 0 (soft pass) so `npm run check` does not break in a parser-less
environment. When a validator is present it is strict: any malformed workflow
fails the check.

To validate a single file by hand without the wrapper:

```bash
actionlint .github/workflows/ci.yml          # if installed
ruby -ryaml -e 'YAML.load_file(ARGV[0])' .github/workflows/ci.yml   # fallback
```
