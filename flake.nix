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

    # pi-wasm: in-browser Pi agent loop subproject (epic bd-f76cee). Node/Vite
    # subflake; only needs nixpkgs + flake-utils (no python/uv2nix toolchain).
    pi-wasm = {
      url = "path:./pi-wasm";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, web-search, linear-extra, pi-wasm, ... }:
    let
      systems = nixpkgs.lib.systems.flakeExposed;
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in {
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
          allPackages = [
            web-search.packages.${system}.web-search-mcp
            linear-extra.packages.${system}.linear-extra-mcp
            skillServer
          ];
        in {
          default = pkgs.symlinkJoin {
            name = "agent-utils";
            paths = allPackages;
          };
          all = self.packages.${system}.default;
          web-search-mcp = web-search.packages.${system}.web-search-mcp;
          linear-extra-mcp = linear-extra.packages.${system}.linear-extra-mcp;
          skill-server = skillServer;
          skill-search = skillServer;
          # pi-wasm browser bundle (static site) + local serve wrapper. Kept out
          # of the `default`/`all` symlinkJoin because it is a web bundle, not a
          # bin. Build: `nix build .#pi-wasm`. Serve: `nix run .#pi-wasm-serve`.
          pi-wasm = pi-wasm.packages.${system}.pi-wasm;
          pi-wasm-serve = pi-wasm.packages.${system}.pi-wasm-serve;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.web-search-mcp}/bin/web-search-mcp";
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
