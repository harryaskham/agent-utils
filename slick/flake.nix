{
  description = "slick — a read-only graphical Slack TUI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Private source is fetched once by Nix over the operator's SSH transport.
    # The build below rewrites Cargo's development-time git dependencies to
    # path dependencies inside this immutable source, so sandboxed cargo
    # vendoring never needs GitHub credentials.
    kittui-src = {
      url = "git+ssh://git@github.com/harryaskham/kittui?rev=c6e39675b31fa7af44d03c644a004de6ad14b371";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, kittui-src, ... }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        patchedSrc = pkgs.runCommand "slick-source" { } ''
          cp -R ${./.} "$out"
          chmod -R u+w "$out"
          substituteInPlace "$out/Cargo.toml" \
            --replace-fail 'ratakittui = { git = "https://github.com/harryaskham/kittui", rev = "c6e39675b31fa7af44d03c644a004de6ad14b371" }' \
                           'ratakittui = { path = "${kittui-src}/crates/ratakittui" }' \
            --replace-fail 'kittui = { git = "https://github.com/harryaskham/kittui", rev = "c6e39675b31fa7af44d03c644a004de6ad14b371" }' \
                           'kittui = { path = "${kittui-src}/crates/kittui" }'
          # Path dependencies have source-less lock entries. Cargo's git lock
          # entries carry no checksum, so deleting only this source line is the
          # exact git -> path lock transformation.
          sed -i '/source = "git+https:\/\/github.com\/harryaskham\/kittui?/d' "$out/Cargo.lock"
        '';
        slick = pkgs.rustPlatform.buildRustPackage {
          pname = "slick";
          version = "0.1.0";
          src = patchedSrc;
          cargoHash = "sha256-F5+V2vx98HUNgrt/hSVYzMOV4A/aJYcHvIPH62Ui1MQ=";
          strictDeps = true;
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
          doCheck = true;
          meta = {
            description = "Read-only graphical Slack TUI with compact cached views";
            homepage = "https://github.com/harryaskham/agent-utils/tree/main/slick";
            license = pkgs.lib.licenses.mit;
            mainProgram = "slick";
            platforms = pkgs.lib.platforms.unix;
          };
        };
      in {
        packages = {
          inherit slick;
          default = slick;
        };
        apps = {
          slick = flake-utils.lib.mkApp { drv = slick; };
          default = self.apps.${system}.slick;
        };
        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.cargo
            pkgs.rustc
            pkgs.rustfmt
            pkgs.clippy
            pkgs.pkg-config
          ];
          buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
        };
      });
}
