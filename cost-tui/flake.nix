{
  description = "cost-tui — daemon-backed multi-account GitHub Copilot usage dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    kittui-src = {
      url = "git+ssh://git@github.com/harryaskham/kittui?rev=fab4b7e39cfe5f515c68ce1188979864b3c632d5";
      flake = false;
    };
    configurable-cli-src = {
      url = "git+ssh://git@github.com/harryaskham/configurable-cli?rev=ed0a5be165f861bb58c81e22fed44153af519060";
      flake = false;
    };
    remote-cli = {
      url = "git+ssh://git@github.com/harryaskham/remote-cli?rev=91d6994ef6103e6a0498930140e112b4f7f492eb";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, kittui-src, configurable-cli-src, remote-cli, ... }:
    let
      remoteModules = remote-cli.lib.mkDaemonModules {
        packageFor = pkgs: pkgs.cost-tui or self.packages.${pkgs.system}.cost-tui;
        appName = "cost-tui";
        displayName = "Cost TUI";
        binary = "cost-tui";
        defaultBind = "127.0.0.1:7622";
        description = "GitHub Copilot usage history collector";
      };
      perSystem = flake-utils.lib.eachDefaultSystem (system:
        let
          pkgs = import nixpkgs { inherit system; };
          patchedSrc = pkgs.runCommand "cost-tui-source" { } ''
            cp -R ${./.} "$out"
            chmod -R u+w "$out"
            substituteInPlace "$out/Cargo.toml" \
              --replace-fail 'ratakittui = { git = "https://github.com/harryaskham/kittui", rev = "fab4b7e39cfe5f515c68ce1188979864b3c632d5" }' \
                             'ratakittui = { path = "${kittui-src}/crates/ratakittui" }' \
              --replace-fail 'kittui-kitty = { git = "https://github.com/harryaskham/kittui", rev = "fab4b7e39cfe5f515c68ce1188979864b3c632d5" }' \
                             'kittui-kitty = { path = "${kittui-src}/crates/kittui-kitty" }' \
              --replace-fail 'kittui = { git = "https://github.com/harryaskham/kittui", rev = "fab4b7e39cfe5f515c68ce1188979864b3c632d5" }' \
                             'kittui = { path = "${kittui-src}/crates/kittui" }' \
              --replace-fail 'configurable-cli = { git = "https://github.com/harryaskham/configurable-cli", rev = "ed0a5be165f861bb58c81e22fed44153af519060" }' \
                             'configurable-cli = { path = "${configurable-cli-src}" }' \
              --replace-fail 'remote-cli = { git = "https://github.com/harryaskham/remote-cli", rev = "91d6994ef6103e6a0498930140e112b4f7f492eb" }' \
                             'remote-cli = { path = "${remote-cli}" }'
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/kittui?/d' "$out/Cargo.lock"
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/configurable-cli?/d' "$out/Cargo.lock"
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/remote-cli?/d' "$out/Cargo.lock"
          '';
          cost-tui = pkgs.rustPlatform.buildRustPackage {
            pname = "cost-tui";
            version = "0.1.0";
            src = patchedSrc;
            # Set to pkgs.lib.fakeHash after Cargo.lock changes, build once, and
            # replace this with the reported vendor hash.
            cargoHash = "sha256-619rgnbvUMb5EgWfSZaIQfuo/w0KYX/pjVVysnqejDo=";
            strictDeps = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
            postInstall = ''
              wrapProgram "$out/bin/cost-tui" \
                --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.gh ]}
            '';
            doCheck = true;
            meta = {
              description = "Daemon-backed multi-account GitHub Copilot usage dashboard";
              homepage = "https://github.com/harryaskham/agent-utils/tree/main/cost-tui";
              license = pkgs.lib.licenses.mit;
              mainProgram = "cost-tui";
              platforms = pkgs.lib.platforms.unix;
            };
          };
        in {
          packages = { inherit cost-tui; default = cost-tui; };
          apps = {
            cost-tui = flake-utils.lib.mkApp { drv = cost-tui; };
            default = self.apps.${system}.cost-tui;
          };
          devShells.default = pkgs.mkShell {
            packages = [
              pkgs.cargo
              pkgs.rustc
              pkgs.rustfmt
              pkgs.clippy
              pkgs.pkg-config
              pkgs.gh
            ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
          };
        });
    in
    perSystem // {
      nixosModules.default = remoteModules.nixos;
      nixosModules.cost-tui = remoteModules.nixos;
      darwinModules.default = remoteModules.darwin;
      darwinModules.cost-tui = remoteModules.darwin;
      nixOnDroidModules.default = remoteModules.nixOnDroid;
      nixOnDroidModules.cost-tui = remoteModules.nixOnDroid;
    };
}
