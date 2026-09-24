{
  description = "Durable agent speech and shared images across configured nodes";
  inputs.nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    systems = nixpkgs.lib.systems.flakeExposed;
    each = nixpkgs.lib.genAttrs systems;
    source = nixpkgs.lib.cleanSourceWith {
      src = ./.;
      filter = path: type:
        !(builtins.elem (builtins.baseNameOf path) [ "target" "result" ])
        && nixpkgs.lib.cleanSourceFilter path type;
    };
  in {
    packages = each (system: let pkgs = import nixpkgs { inherit system; }; in rec {
      ag = pkgs.rustPlatform.buildRustPackage {
        pname = "ag";
        version = "0.3.0";
        src = source;
        cargoDeps = (pkgs.rustPlatform.importCargoLock.override {
          fetchurl = attrs: pkgs.fetchurl (attrs // {
            url = builtins.replaceStrings
              [ "https://crates.io/api/v1/crates/" ]
              [ "https://static.crates.io/crates/" ] attrs.url;
          });
        }) {
          lockFile = ./Cargo.lock;
          outputHashes = {
            "mcp-cli-core-0.0.1" = "sha256-IZ9SX1iUWYv8mUufYVWiEOvVC55peViCnGTcdqpCMBs=";
            "configurable-cli-0.1.0" = "sha256-IVudlEigzZUpuBjCE5V/CB6Z/C3I7MN8DwxGND31/L0=";
          };
        };
        nativeBuildInputs = [ pkgs.makeWrapper pkgs.installShellFiles ];
        nativeCheckInputs = [ pkgs.rsync ];
        postInstall = ''
          installShellCompletion --cmd ag \
            --bash <($out/bin/ag completions bash) \
            --zsh <($out/bin/ag completions zsh) \
            --fish <($out/bin/ag completions fish)
          wrapProgram $out/bin/ag --prefix PATH : ${pkgs.lib.makeBinPath ([ pkgs.openssh pkgs.rsync ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [ pkgs.xdg-utils ])}
          mkdir -p $out/share/doc/ag
          cp README.md acceptance.json gallery-acceptance.json $out/share/doc/ag/
        '';
        meta = {
          description = "Durable agent speech and shared images across your machines";
          mainProgram = "ag";
          license = pkgs.lib.licenses.mit;
          platforms = pkgs.lib.platforms.unix;
        };
      };
      default = ag;
    });
    apps = each (system: rec {
      ag = { type = "app"; program = "${self.packages.${system}.ag}/bin/ag"; };
      default = ag;
    });
    checks = each (system: { inherit (self.packages.${system}) ag; });
    devShells = each (system: let pkgs = import nixpkgs { inherit system; }; in {
      default = pkgs.mkShell { packages = with pkgs; [ cargo rustc rustfmt clippy openssh rsync ]; };
    });
  };
}
