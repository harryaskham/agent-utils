{
  description = "pi-wasm: fully in-browser Pi agent loop — reproducible browser-bundle build + local serve (epic bd-f76cee, S9 bd-82b969)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils, ... }:
    let
      systems = nixpkgs.lib.systems.flakeExposed;
      forAllSystems = nixpkgs.lib.genAttrs systems;

      # Default local serve port; matches the scaffold's `vite preview` port so
      # docs stay consistent. Override as the first arg to `pi-wasm-serve`.
      defaultPort = "4319";
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };

          # Deterministic browser bundle: buildNpmPackage installs the pinned
          # package-lock.json deps as a fixed-output derivation (npmDepsHash),
          # runs `vite build`, and we install the emitted static `dist/` tree as
          # the package output ($out is the web root: index.html at $out/).
          #
          # If package-lock.json changes, recompute the hash with:
          #   nix run github:NixOS/nixpkgs/nixos-unstable#prefetch-npm-deps -- pi-wasm/package-lock.json
          pi-wasm = pkgs.buildNpmPackage {
            pname = "pi-wasm";
            version = "0.0.0";
            src = ./.;
            # npmDepsHash: FOD hash of the vendored package-lock.json deps.
            # Recompute when deps OR the pinned nixpkgs' prefetch-npm-deps change
            # (the FOD canonicalization is nixpkgs-version-sensitive):
            #   nix run github:NixOS/nixpkgs/nixos-unstable#prefetch-npm-deps -- pi-wasm/package-lock.json
            # (bd-dd6419: refreshed from the stale S9 value that broke `nix build
            # .#pi-wasm` — the very undetected-drift this gate exists to catch.)
            npmDepsHash = "sha256-VDnEj7+f8fNbovRbCLTTk8YZacph+YdKSoWrUah6sVA=";
            npmBuildScript = "build";
            # bd-dd6419: make `nix build .#pi-wasm` a COMPLETE gate. The build
            # script is `vite build`, which uses esbuild — it strips types
            # WITHOUT typechecking and never runs the vitest suite, so on its
            # own this derivation only catches bundling breaks. Run tsc + vitest
            # in the check phase (devDeps are present pre-install-prune, deps are
            # vendored offline via npmDepsHash, and the suite is network-free) so
            # a type error or a failing test fails this hermetic, nix-cached
            # build. This lets the daemon before_reintegration gate collapse to a
            # one-line `nix build .#pi-wasm` (only rebuilds/tests when pi-wasm
            # inputs change; cache hit is near-instant otherwise).
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              npm run typecheck
              npm run test
              runHook postCheck
            '';
            # This is a static site, not a publishable npm library: skip the
            # default `npm install`-style install and copy the vite `dist/` tree
            # so $out is a ready-to-serve web root.
            dontNpmInstall = true;
            installPhase = ''
              runHook preInstall
              mkdir -p "$out"
              cp -r dist/. "$out/"
              runHook postInstall
            '';
            meta = {
              description = "In-browser Pi agent loop static bundle (epic bd-f76cee)";
            };
          };

          # `pi-wasm-serve [port]` — serve the built bundle over a local static
          # HTTP server (default port 4319). Read-only nix store root is fine.
          pi-wasm-serve = pkgs.writeShellApplication {
            name = "pi-wasm-serve";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              root="${pi-wasm}"
              port="''${1:-${defaultPort}}"
              echo "pi-wasm: serving $root on http://localhost:$port (Ctrl-C to stop)"
              cd "$root"
              exec python3 -m http.server "$port" --bind 127.0.0.1
            '';
          };
        in
        {
          default = pi-wasm;
          inherit pi-wasm pi-wasm-serve;
        }
      );

      apps = forAllSystems (system: {
        default = self.apps.${system}.serve;
        serve = {
          type = "app";
          program = "${self.packages.${system}.pi-wasm-serve}/bin/pi-wasm-serve";
        };
      });

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.python3
            ];
          };
        }
      );
    };
}
