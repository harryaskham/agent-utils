{
  description = "agent-utils package collator";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    web-search = {
      url = "path:./web-search";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
      inputs.pyproject-build-systems.follows = "pyproject-build-systems";
    };

    linear-extra = {
      url = "path:./linear-extra";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
      inputs.pyproject-build-systems.follows = "pyproject-build-systems";
    };

    ag = {
      url = "path:./ag";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # pi-wasm: in-browser Pi agent loop subproject (epic bd-f76cee). Node/Vite
    # subflake; only needs nixpkgs + flake-utils (no python/uv2nix toolchain).
    pi-wasm = {
      url = "path:./pi-wasm";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, web-search, linear-extra, pi-wasm, ag, ... }:
    let
      systems = nixpkgs.lib.systems.flakeExposed;
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
      # Independently usable Linux Home Manager service for the ag dashboard.
      inherit (ag) homeManagerModules;
      packages = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
          skillServer = pkgs.rustPlatform.buildRustPackage {
            pname = "skill-server";
            version = "0.1.0";
            src = ./.;
            cargoLock.lockFile = ./Cargo.lock;
            cargoBuildFlags = [ "-p" "skill-server" ];
            cargoTestFlags = [ "-p" "skill-server" ];
          };
          piSession = pkgs.stdenvNoCC.mkDerivation {
            pname = "pi-session";
            version = "1.0.0";
            src = ./.;
            nativeBuildInputs = [ pkgs.nodejs_22 pkgs.git pkgs.openssh pkgs.makeWrapper ];
            dontBuild = true;
            doCheck = true;
            checkPhase = ''
              runHook preCheck
              export HOME=$(mktemp -d)
              patchShebangs scripts/pi-session.mjs
              node --test test/session-fork*.test.js
              runHook postCheck
            '';
            installPhase = ''
              mkdir -p $out/lib/pi-session/extensions/lib $out/lib/pi-session/scripts $out/bin
              cp package.json $out/lib/pi-session/
              cp -r extensions/lib/session-fork $out/lib/pi-session/extensions/lib/
              cp scripts/pi-session.mjs $out/lib/pi-session/scripts/
              makeWrapper ${pkgs.nodejs_22}/bin/node $out/bin/pi-session \
                --add-flags "$out/lib/pi-session/scripts/pi-session.mjs" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git pkgs.openssh ]}
            '';
            meta.mainProgram = "pi-session";
          };
          allPackages = [
            piSession
            web-search.packages.${system}.web-search-mcp
            linear-extra.packages.${system}.linear-extra-mcp
            skillServer
            ag.packages.${system}.ag
          ];
          withoutChecks = package: package.overrideAttrs (_: {
            doCheck = false;
          });
          webSearchUnchecked = withoutChecks web-search.packages.${system}.web-search-mcp;
          linearExtraUnchecked = withoutChecks linear-extra.packages.${system}.linear-extra-mcp;
          skillServerUnchecked = withoutChecks skillServer;
          agUnchecked = withoutChecks ag.packages.${system}.ag;
          uncheckedPackages = [
            (withoutChecks piSession)
            webSearchUnchecked
            linearExtraUnchecked
            skillServerUnchecked
            agUnchecked
          ];
          # pi-daemon Durable extension modules (bd-832b7a, bd-647b05). `$out/tts.mjs`
          # and `$out/media.mjs` are the modules a pi-daemon profile lists under
          # `extensions:`; they load the shared agent-utils libraries from
          # `$out/extensions`. Playback
          # binaries are recorded as absolute paths so the worker's PATH does not
          # need Pulse tools.
          durableExtensions = pkgs.runCommand "agent-utils-durable-extensions" {
            nativeBuildInputs = [ pkgs.nodejs ];
          } ''
            mkdir -p $out
            cp -r ${./extensions} $out/extensions
            chmod -R u+w $out
            echo '{ "type": "module" }' > $out/package.json
            ${pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              echo '{ "pacat": "${pkgs.pulseaudio}/bin/pacat" }' > $out/extensions/durable/runtime-paths.json
            ''}
            echo 'export * from "./extensions/durable/tts.mjs";' > $out/tts.mjs
            # image_share, audio_share and tendril_capture (bd-647b05).
            echo 'export * from "./extensions/durable/media.mjs";' > $out/media.mjs
            # An image budget for model requests (bd-cf6146).
            echo 'export * from "./extensions/durable/image-budget.mjs";' > $out/image-budget.mjs
            # /loop as Durable background tasks.
            echo 'export * from "./extensions/durable/loop.mjs";' > $out/loop.mjs
            # Cacophony visiting registration (needs pi-daemon's per-session environment).
            echo 'export * from "./extensions/durable/cacophony.mjs";' > $out/cacophony.mjs
            # interactive_choice and async_choice on pi-daemon's questions (pi-daemon 1.13).
            echo 'export * from "./extensions/durable/choice.mjs";' > $out/choice.mjs
            # The modules must load with nothing but Node built-ins.
            HOME=$TMPDIR node --input-type=module -e "
              const m = await import('$out/tts.mjs');
              if (typeof m.observe !== 'function' || typeof m.commands?.tts?.run !== 'function' || typeof m.commands?.narrate?.run !== 'function') process.exit(1);
              const media = await import('$out/media.mjs');
              const names = (media.extension?.tools ?? []).map((tool) => tool.name).join(',');
              if (media.extension?.name !== 'agent-utils-media' || names !== 'image_share,audio_share,tendril_capture') process.exit(1);
              const budget = await import('$out/image-budget.mjs');
              if (budget.extension?.name !== 'agent-utils-image-budget' || budget.extension.hooks?.[0]?.task !== 'pi.generation') process.exit(1);
              const loop = await import('$out/loop.mjs');
              const caco = await import('$out/cacophony.mjs');
              const choice = await import('$out/choice.mjs');
              const choiceTools = (choice.extension?.tools ?? []).map((tool) => tool.name).join(',');
              if (choice.extension?.tasks?.[0]?.definition?.name !== 'agent-utils.async-choice' || choiceTools !== 'interactive_choice,async_choice,async_choice_status,async_choice_cancel') process.exit(1);
              if (caco.extension?.sections?.[0]?.key !== 'cacophony' || typeof caco.commands?.['caco-agent-register']?.run !== 'function' || typeof caco.observe !== 'function') process.exit(1);
              const loopTools = (loop.extension?.tools ?? []).map((tool) => tool.name).join(',');
              if (loop.extension?.tasks?.[0]?.definition?.name !== 'agent-utils.loop' || typeof loop.commands?.loop?.run !== 'function' || typeof loop.commands?.loops?.run !== 'function' || loopTools !== 'create_loop,list_loops,stop_loop') process.exit(1);
            "
          '';
          uncheckedJoin = pkgs.symlinkJoin {
            name = "agent-utils-unchecked";
            paths = uncheckedPackages;
            # CLI aggregate: shared Rust cdylibs from sibling packages may use
            # identical generic paths (for example lib/libhtml2md.so).
            pathsToLink = [ "/bin" ];
          };
        in {
          default = pkgs.symlinkJoin {
            name = "agent-utils";
            paths = allPackages;
            pathsToLink = [ "/bin" ];
          };
          pi-session = piSession;
          pi-session-unchecked = withoutChecks piSession;
          ag = ag.packages.${system}.ag;
          ag-unchecked = agUnchecked;
          all = self.packages.${system}.default;
          unchecked = uncheckedJoin;
          all-unchecked = uncheckedJoin;
          web-search-mcp = web-search.packages.${system}.web-search-mcp;
          web-search-mcp-unchecked = webSearchUnchecked;
          linear-extra-mcp = linear-extra.packages.${system}.linear-extra-mcp;
          linear-extra-mcp-unchecked = linearExtraUnchecked;
          skill-server = skillServer;
          skill-server-unchecked = skillServerUnchecked;
          skill-search = skillServer;
          skill-search-unchecked = skillServerUnchecked;
          # pi-wasm browser bundle (static site) + local serve wrapper. Kept out
          # of the `default`/`all` symlinkJoin because it is a web bundle, not a
          # bin. Build: `nix build .#pi-wasm`. Serve: `nix run .#pi-wasm-serve`.
          pi-wasm = pi-wasm.packages.${system}.pi-wasm;
          durable-extensions = durableExtensions;
          pi-wasm-serve = pi-wasm.packages.${system}.pi-wasm-serve;
        });

      # Consumer overlay for the remaining agent-utils binaries. Standalone
      # applications such as Slick, Annum, and Cost own their own overlays.
      overlays.default = final: prev: let
        packages = self.packages.${prev.system};
      in {
        agent-utils = packages.unchecked;
        pi-session = packages.pi-session-unchecked;
        ag = packages.ag-unchecked;
        web-search-mcp = packages.web-search-mcp-unchecked;
        linear-extra-mcp = packages.linear-extra-mcp-unchecked;
        skill-server = packages.skill-server-unchecked;
        skill-search = packages.skill-search-unchecked;
      };
      overlays.unchecked = self.overlays.default;

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.web-search-mcp}/bin/web-search-mcp";
        };
        ag = {
          type = "app";
          program = "${self.packages.${system}.ag}/bin/ag";
        };
        pi-session = {
          type = "app";
          program = "${self.packages.${system}.pi-session}/bin/pi-session";
        };
        web-search-mcp = self.apps.${system}.default;
        linear-extra-mcp = {
          type = "app";
          program = "${self.packages.${system}.linear-extra-mcp}/bin/linear-extra-mcp";
        };
        skill-server = {
          type = "app";
          program = "${self.packages.${system}.skill-server}/bin/skill-server";
        };
        skill-search = {
          type = "app";
          program = "${self.packages.${system}.skill-server}/bin/skill-search";
        };
        pi-wasm-serve = {
          type = "app";
          program = "${self.packages.${system}.pi-wasm-serve}/bin/pi-wasm-serve";
        };
      });

      checks = forAllSystems (system: {
        pi-session = self.packages.${system}.pi-session;
        ag = ag.packages.${system}.ag;
        ag-dash-module = ag.checks.${system}.ag-dash-module;
      });

      devShells = forAllSystems (system:
        let
          pkgs = import nixpkgs { inherit system; };
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.nixd
              pkgs.nixfmt-rfc-style
              pkgs.cargo
              pkgs.rustc
              pkgs.rustfmt
              pkgs.clippy
              # bd-ce9baf: GitHub Actions workflow linter. `npm run lint:workflows`
              # uses actionlint when it is on PATH (as it is inside this shell)
              # for full semantic checks, and falls back to a YAML well-formedness
              # check otherwise.
              pkgs.actionlint
              # bd-7eb473: CI runs every job via `nix develop --command` on the
              # azure-ephemeral runners (Nix preinstalled, but no system
              # toolchains — e.g. `cc`/node are absent), so the devShell must
              # provide all CI toolchains. rust (cargo/rustc/rustfmt/clippy) + cc
              # (from stdenv) + actionlint are already above; add nodejs for the
              # JS jobs and cargo-audit for the dependency-audit job. (CI used
              # node 20, but nodejs_20 is EOL/insecure in nixpkgs; node 22 LTS is
              # API-compatible for the node:test suite — validated green.)
              pkgs.nodejs_22
              pkgs.cargo-audit
            ];
          };
        });
    };
}
