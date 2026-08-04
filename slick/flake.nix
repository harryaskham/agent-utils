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
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      kittui-src,
      ...
    }:
    let
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
            # Regenerate whenever Cargo.lock changes (e.g. adding serde_yaml in
            # 132b67d). A stale value fails the build with "cargoHash or
            # cargoSha256 is out of date": set to pkgs.lib.fakeHash, build, and
            # copy the reported "got:" hash back here.
            cargoHash = "sha256-TZFvF48HoDx4rb2xZ9aUBwI3FeTJP4YFyeXwtpTj3wM=";
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
      nixosModules.default = self.nixosModules.slick;
      nixosModules.slick =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.slick;
          args = [
            "${lib.getExe cfg.package}"
            "--config"
            cfg.configFile
            "--cache"
            cfg.cacheFile
            "daemon"
            "--bind"
            cfg.bind
          ]
          ++ lib.optionals (cfg.tokenFile != null) [
            "--token-file"
            cfg.tokenFile
          ]
          ++ cfg.extraArgs;
        in
        {
          options.services.slick = {
            enable = lib.mkEnableOption "Slick Slack cache collector";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.slick;
              description = "Slick package whose daemon owns Slack API refreshes.";
            };
            bind = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1:7612";
              description = "Authenticated snapshot/SSE bind address.";
            };
            configFile = lib.mkOption {
              type = lib.types.str;
              default = "%h/.config/slick/config.yaml";
              description = "Slick YAML config path (systemd specifiers allowed).";
            };
            cacheFile = lib.mkOption {
              type = lib.types.str;
              default = "%h/.cache/slick/state.json";
              description = "Atomic Slick cache path (systemd specifiers allowed).";
            };
            tokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Existing owner-only bearer token file. Null lets Slick generate daemon-token beside config mode 0600.";
            };
            extraArgs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Extra arguments appended to slick daemon.";
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
            systemd.user.services.slick-daemon = {
              description = "Slick rate-limit-aware Slack cache collector";
              wantedBy = [ "default.target" ];
              unitConfig.ConditionUser = "!@system";
              serviceConfig = {
                ExecStart = lib.escapeShellArgs args;
                Restart = "on-failure";
                RestartSec = 5;
                RestartSteps = 5;
                RestartMaxDelaySec = 300;
              };
            };
          };
        };

      darwinModules.default = self.darwinModules.slick;
      darwinModules.slick =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.slick;
          primaryUser = config.system.primaryUser or "harryaskham";
          home = config.users.users.${primaryUser}.home or "/Users/${primaryUser}";
          args = [
            "${lib.getExe cfg.package}"
            "--config"
            cfg.configFile
            "--cache"
            cfg.cacheFile
            "daemon"
            "--bind"
            cfg.bind
          ]
          ++ lib.optionals (cfg.tokenFile != null) [
            "--token-file"
            cfg.tokenFile
          ]
          ++ cfg.extraArgs;
        in
        {
          options.services.slick = {
            enable = lib.mkEnableOption "Slick Slack cache collector";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.slick;
              description = "Slick package whose daemon runs as a launchd agent.";
            };
            bind = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1:7612";
              description = "Authenticated snapshot/SSE bind address.";
            };
            configFile = lib.mkOption {
              type = lib.types.str;
              default = "${home}/.config/slick/config.yaml";
              description = "Slick YAML config path.";
            };
            cacheFile = lib.mkOption {
              type = lib.types.str;
              default = "${home}/Library/Caches/slick/state.json";
              description = "Atomic Slick cache path.";
            };
            tokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Existing owner-only bearer token file. Null lets Slick generate daemon-token beside config mode 0600.";
            };
            extraArgs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Extra arguments appended to slick daemon.";
            };
          };

          config = lib.mkIf cfg.enable {
            environment.systemPackages = [ cfg.package ];
            launchd.user.agents.slick-daemon = {
              command = lib.escapeShellArgs args;
              serviceConfig = {
                KeepAlive = true;
                RunAtLoad = true;
                ProcessType = "Background";
                ThrottleInterval = 5;
                StandardOutPath = "${home}/Library/Logs/slick-daemon.log";
                StandardErrorPath = "${home}/Library/Logs/slick-daemon.err.log";
              };
            };
          };
        };

      # Nix-on-Droid has no systemd/launchd. This module targets the
      # supervisord.programs contract provided by the collective NOD base.
      nixOnDroidModules.default = self.nixOnDroidModules.slick;
      nixOnDroidModules.slick =
        {
          config,
          lib,
          pkgs,
          ...
        }:
        let
          cfg = config.services.slick;
          args = [
            "${lib.getExe cfg.package}"
            "--config"
            cfg.configFile
            "--cache"
            cfg.cacheFile
            "daemon"
            "--bind"
            cfg.bind
          ]
          ++ lib.optionals (cfg.tokenFile != null) [
            "--token-file"
            cfg.tokenFile
          ]
          ++ cfg.extraArgs;
        in
        {
          options.services.slick = {
            enable = lib.mkEnableOption "Slick Slack cache collector";
            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.system}.slick;
              description = "Slick package managed by Nix-on-Droid supervisord.";
            };
            homeDir = lib.mkOption {
              type = lib.types.str;
              default = "/home/nix-on-droid";
              description = "Home directory exported to the Slick process.";
            };
            bind = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1:7612";
              description = "Authenticated snapshot/SSE bind address.";
            };
            configFile = lib.mkOption {
              type = lib.types.str;
              default = "${cfg.homeDir}/.config/slick/config.yaml";
              description = "Slick YAML config path.";
            };
            cacheFile = lib.mkOption {
              type = lib.types.str;
              default = "${cfg.homeDir}/.cache/slick/state.json";
              description = "Atomic Slick cache path.";
            };
            tokenFile = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Existing owner-only bearer token file. Null lets Slick generate daemon-token beside config mode 0600.";
            };
            extraArgs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Extra arguments appended to slick daemon.";
            };
          };

          config = lib.mkIf cfg.enable {
            environment.packages = [ cfg.package ];
            supervisord.programs.slick-daemon = {
              command = lib.escapeShellArgs args;
              directory = cfg.homeDir;
              path = [ cfg.package ];
              autostart = true;
              autorestart = true;
              startsecs = 2;
              environment = {
                HOME = cfg.homeDir;
                XDG_CONFIG_HOME = "${cfg.homeDir}/.config";
                XDG_CACHE_HOME = "${cfg.homeDir}/.cache";
              };
            };
          };
        };
    };
}
