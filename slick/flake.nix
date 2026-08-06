{
  description = "slick — a read-only-by-default graphical Slack TUI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    # Private source is fetched once by Nix over the operator's SSH transport.
    # The build below rewrites Cargo's development-time git dependencies to
    # path dependencies inside this immutable source, so sandboxed cargo
    # vendoring never needs GitHub credentials.
    kittui-src = {
      url = "git+ssh://git@github.com/harryaskham/kittui?rev=fab4b7e39cfe5f515c68ce1188979864b3c632d5";
      flake = false;
    };
    mcp-cli-src = {
      url = "git+ssh://git@github.com/harryaskham/mcp-cli?rev=81e55235df7d7335d4dc7bd1095131246d157a2a";
      flake = false;
    };
    configurable-cli-src = {
      url = "git+ssh://git@github.com/harryaskham/configurable-cli?rev=ed0a5be165f861bb58c81e22fed44153af519060";
      flake = false;
    };
    remote-cli = {
      url = "git+ssh://git@github.com/harryaskham/remote-cli?rev=4c528bc6f31755d9c9b95e0e44807cb6a8955143";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      kittui-src,
      mcp-cli-src,
      configurable-cli-src,
      remote-cli,
      ...
    }:
    let
      remoteModules = remote-cli.lib.mkDaemonModules {
        # Honor a consumer overlay (for example pkgs.slick = slick-unchecked)
        # while retaining a standalone-flake fallback.
        packageFor = pkgs: pkgs.slick or self.packages.${pkgs.system}.slick;
        appName = "slick";
        displayName = "Slick";
        binary = "slick";
        defaultBind = "127.0.0.1:7612";
        description = "Slick rate-limit-aware Slack cache collector";
      };
      perSystem = flake-utils.lib.eachDefaultSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          patchedSrc = pkgs.runCommand "slick-source" { } ''
            cp -R ${./.} "$out"
            chmod -R u+w "$out"
            substituteInPlace "$out/Cargo.toml" \
              --replace-fail 'ratakittui = { git = "https://github.com/harryaskham/kittui", rev = "fab4b7e39cfe5f515c68ce1188979864b3c632d5" }' \
                             'ratakittui = { path = "${kittui-src}/crates/ratakittui" }' \
              --replace-fail 'kittui-kitty = { git = "https://github.com/harryaskham/kittui", rev = "fab4b7e39cfe5f515c68ce1188979864b3c632d5" }' \
                             'kittui-kitty = { path = "${kittui-src}/crates/kittui-kitty" }' \
              --replace-fail 'kittui = { git = "https://github.com/harryaskham/kittui", rev = "fab4b7e39cfe5f515c68ce1188979864b3c632d5" }' \
                             'kittui = { path = "${kittui-src}/crates/kittui" }' \
              --replace-fail 'mcp-cli = { package = "mcp-cli-core", git = "https://github.com/harryaskham/mcp-cli", rev = "81e55235df7d7335d4dc7bd1095131246d157a2a" }' \
                             'mcp-cli = { package = "mcp-cli-core", path = "${mcp-cli-src}" }' \
              --replace-fail 'configurable-cli = { git = "https://github.com/harryaskham/configurable-cli", rev = "ed0a5be165f861bb58c81e22fed44153af519060" }' \
                             'configurable-cli = { path = "${configurable-cli-src}" }' \
              --replace-fail 'remote-cli = { git = "https://github.com/harryaskham/remote-cli", rev = "4c528bc6f31755d9c9b95e0e44807cb6a8955143" }' \
                             'remote-cli = { path = "${remote-cli}" }'
            # Path dependencies have source-less lock entries. Cargo's git lock
            # entries carry no checksum, so deleting only this source line is the
            # exact git -> path lock transformation.
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/kittui?/d' "$out/Cargo.lock"
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/mcp-cli?/d' "$out/Cargo.lock"
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/configurable-cli?/d' "$out/Cargo.lock"
            sed -i '/source = "git+https:\/\/github.com\/harryaskham\/remote-cli?/d' "$out/Cargo.lock"
            mkdir -p "$out/.cargo"
            cat > "$out/.cargo/config.toml" <<EOF
            [patch."https://github.com/harryaskham/mcp-cli"]
            mcp-cli-core = { path = "${mcp-cli-src}" }
            EOF
          '';
          slick = pkgs.rustPlatform.buildRustPackage {
            pname = "slick";
            version = "0.1.0";
            src = patchedSrc;
            # Regenerate whenever Cargo.lock changes (e.g. adding serde_yaml in
            # 132b67d). A stale value fails the build with "cargoHash or
            # cargoSha256 is out of date": set to pkgs.lib.fakeHash, build, and
            # copy the reported "got:" hash back here.
            cargoHash = "sha256-2CfkZDgQDGTDM9dePK+DM5mb9+OUBWzoo0r3u9JMfL4=";
            strictDeps = true;
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
            doCheck = true;
            meta = {
              description = "Read-only-by-default graphical Slack TUI with compact cached views";
              homepage = "https://github.com/harryaskham/agent-utils/tree/main/slick";
              license = pkgs.lib.licenses.mit;
              mainProgram = "slick";
              platforms = pkgs.lib.platforms.unix;
            };
          };
        in
        {
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
        }
      );
    in
    perSystem
    // {
      nixosModules.default = remoteModules.nixos;
      nixosModules.slick = remoteModules.nixos;
      darwinModules.default = remoteModules.darwin;
      darwinModules.slick = remoteModules.darwin;
      nixOnDroidModules.default = remoteModules.nixOnDroid;
      nixOnDroidModules.slick = remoteModules.nixOnDroid;
    };
}
