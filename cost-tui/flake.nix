{
  description = "cost-tui — a graphical multi-account GitHub Copilot usage dashboard";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    kittui-src = {
      url = "git+ssh://git@github.com/harryaskham/kittui?rev=fab4b7e39cfe5f515c68ce1188979864b3c632d5";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, kittui-src, ... }:
    flake-utils.lib.eachDefaultSystem (system:
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
                           'kittui = { path = "${kittui-src}/crates/kittui" }'
          sed -i '/source = "git+https:\/\/github.com\/harryaskham\/kittui?/d' "$out/Cargo.lock"
        '';
        cost-tui = pkgs.rustPlatform.buildRustPackage {
          pname = "cost-tui";
          version = "0.1.0";
          src = patchedSrc;
          # Set to pkgs.lib.fakeHash after Cargo.lock changes, build once, and
          # replace this with the reported vendor hash.
          cargoHash = "sha256-PVVWAThVv3ER/mraHi8WgJX6MtX3Y+yYLQFN4HhIAAk=";
          strictDeps = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
          postInstall = ''
            wrapProgram "$out/bin/cost-tui" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.gh ]}
          '';
          doCheck = true;
          meta = {
            description = "Graphical multi-account GitHub Copilot usage dashboard";
            homepage = "https://github.com/harryaskham/agent-utils/tree/main/cost-tui";
            license = pkgs.lib.licenses.mit;
            mainProgram = "cost-tui";
            platforms = pkgs.lib.platforms.unix;
          };
        };
      in {
        packages = {
          inherit cost-tui;
          default = cost-tui;
        };
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
}
