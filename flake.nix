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
  };

  outputs = { self, nixpkgs, flake-utils, web-search, ... }:
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
            skillServer
          ];
        in {
          default = pkgs.symlinkJoin {
            name = "agent-utils";
            paths = allPackages;
          };
          all = self.packages.${system}.default;
          web-search-mcp = web-search.packages.${system}.web-search-mcp;
          skill-server = skillServer;
          ss = skillServer;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.web-search-mcp}/bin/web-search-mcp";
        };
        web-search-mcp = self.apps.${system}.default;
        skill-server = {
          type = "app";
          program = "${self.packages.${system}.skill-server}/bin/skill-server";
        };
        ss = {
          type = "app";
          program = "${self.packages.${system}.skill-server}/bin/ss";
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
            ];
          };
        });
    };
}
