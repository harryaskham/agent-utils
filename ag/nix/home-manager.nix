# Foreground ag dash supervised by the user's systemd manager. No activation
# scripts, host/credential rewrites, firewall changes or Tailscale Serve routes.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.ag-dash;
  ip = if lib.hasInfix ":" cfg.bindAddress then "[${cfg.bindAddress}]" else cfg.bindAddress;
  args = [
    (lib.getExe' cfg.package "ag")
    "--config"
    cfg.configFile
    "dash"
    "--no-open"
    "--bind"
    "${ip}:${toString cfg.port}"
    "--access"
    cfg.access
    "--token-file"
    cfg.tokenFile
    "--refresh"
    (toString cfg.refreshSeconds)
    "--image-refresh"
    (toString cfg.imageRefreshSeconds)
    "--tts-lines"
    (toString cfg.ttsLines)
  ]
  ++ lib.optionals (cfg.publicOrigin != null) [
    "--public-origin"
    cfg.publicOrigin
  ]
  ++ lib.optionals (cfg.cacheDirectory != null) [
    "--cache-dir"
    cfg.cacheDirectory
  ]
  ++ lib.optionals (cfg.audioCacheDirectory != null) [
    "--audio-cache-dir"
    cfg.audioCacheDirectory
  ]
  ++ lib.optional (!cfg.images) "--no-images"
  ++ lib.optional (!cfg.audio) "--no-audio"
  ++ lib.optional (!cfg.tts) "--no-tts";
  # Use a store-owned launcher so systemd does not reinterpret %, $, quotes or
  # whitespace in user-specified arguments/environment. Never shell-eval config.
  launcher = pkgs.writeShellScript "ag-dash-start" ''
    set -euo pipefail
    umask 077
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (name: value: "export ${name}=${lib.escapeShellArg value}") (
        {
          HOME = config.home.homeDirectory;
          XDG_CONFIG_HOME = config.xdg.configHome;
          XDG_STATE_HOME = config.xdg.stateHome;
          XDG_CACHE_HOME = config.xdg.cacheHome;
          AG_STATE_DIR = cfg.stateDirectory;
        }
        // cfg.environment
      )
    )}
    exec ${lib.escapeShellArgs args}
  '';
in
{
  options.services.ag-dash = {
    enable = lib.mkEnableOption "the ag fleet dashboard (Linux user service)";
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.ag or self.packages.${pkgs.system}.ag;
      description = "ag package providing dash; defaults to the configured package or this flake.";
    };
    bindAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      example = "100.83.90.42";
      description = "Listener IP without a port or IPv6 brackets. Wildcards 0.0.0.0 and :: are supported. Binding does not configure firewall, TLS or Tailscale Serve.";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 7795;
    };
    publicOrigin = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "http://helsinki.miku-owl.ts.net:7795";
      description = "Public HTTP(S) origin for the displayed URL and allowed Host header; independent of the listener IP. No path/query/credentials.";
    };
    configFile = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.configHome}/ag/config.yaml";
      description = "Existing runtime ag configuration. Managed symlinks are supported; the service never rewrites it.";
    };
    stateDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.stateHome}/ag";
      description = "Private collector state (AHP client identities and default access token).";
    };
    access = lib.mkOption {
      type = lib.types.enum [
        "auto"
        "open"
        "token"
      ];
      default = "auto";
      description = "Token policy. auto: no token on loopback and Tailscale addresses (the tailnet is the boundary), a token on wildcard/LAN binds. open: never a token. token: always a token. Host pinning and same-origin checks on answers apply in every mode.";
    };
    tokenFile = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.stateDirectory}/dash/token";
      description = "Private persistent dashboard token, used only when access requires one; generated at runtime if absent. An existing SOPS/managed symlink is read without replacement. Contents never enter the Nix store or service log. Append ?token=<contents> on the first browser visit.";
    };
    cacheDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional gallery cache override; null uses the ag config/XDG default.";
    };
    audioCacheDirectory = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional shared-audio cache override; null uses gallery.audio_cache_dir or ~/.cache/ag/audio.";
    };
    refreshSeconds = lib.mkOption {
      type = lib.types.ints.between 30 86400;
      default = 300;
    };
    imageRefreshSeconds = lib.mkOption {
      type = lib.types.ints.between 60 86400;
      default = 300;
      description = "Media sync cadence: images and shared audio are pulled together on this interval.";
    };
    images = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Periodically pull images; false serves only existing cached images.";
    };
    audio = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Periodically pull explicitly shared audio (same cadence as images) for the Audio tab; false serves only the existing audio cache. Playback happens in the browser, never on the server.";
    };
    tts = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Collect the ag tts request feed once in this job and stream it to authenticated browsers; no audio playback. False adds --no-tts. Runtime dash.tts=false also disables collection.";
    };
    ttsLines = lib.mkOption {
      type = lib.types.ints.between 0 1000;
      default = 20;
      description = "Recent speech records per host on service startup (not per browser). Live appends then follow automatically.";
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        SSH_AUTH_SOCK = "/run/user/1000/ssh-agent";
      };
      description = "Extra runtime environment (e.g. an SSH-agent socket). Values are store-visible: use paths, never secret contents.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isLinux;
        message = "services.ag-dash requires Linux systemd user services.";
      }
      {
        assertion = lib.all (name: builtins.match "[A-Za-z_][A-Za-z0-9_]*" name != null) (
          builtins.attrNames cfg.environment
        );
        message = "services.ag-dash.environment keys must be shell variable names.";
      }
    ];
    systemd.user.services.ag-dash = {
      Unit = {
        Description = "ag fleet dashboard";
        After = [ "network-online.target" ];
        Wants = [ "network-online.target" ];
        # Retry even if the configured tailnet IP is unavailable at login/boot.
        StartLimitIntervalSec = 0;
      };
      Service = {
        ExecStart = toString launcher;
        WorkingDirectory = config.home.homeDirectory;
        Restart = "always";
        RestartSec = 5;
        KillSignal = "SIGTERM";
        KillMode = "control-group";
        TimeoutStopSec = 30;
        UMask = "0077";
        NoNewPrivileges = true;
      };
      Install.WantedBy = [ "default.target" ];
    };
  };
}
