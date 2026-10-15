# Evaluate the HM contract without adding a second Home Manager/nixpkgs input.
# Collective separately evaluates this against its real pinned HM configuration.
{ pkgs, module }:
let
  inherit (pkgs) lib;
  attrs = lib.mkOption {
    type = lib.types.attrs;
    default = { };
  };
  package = pkgs.writeShellScriptBin "ag" ''
    printf '%s\n' "$@"
  '';
  eval =
    settings:
    (lib.evalModules {
      specialArgs.pkgs = pkgs // {
        stdenv = pkgs.stdenv // {
          hostPlatform = pkgs.stdenv.hostPlatform // {
            isLinux = true;
          };
        };
        # Inspect launch scripts without import-from-derivation or execution.
        # The check's nativeBuildInputs explicitly realizes the mock executable.
        writeShellScript = name: text: builtins.toFile name (builtins.unsafeDiscardStringContext text);
      };
      modules = [
        module
        {
          options.home.homeDirectory = lib.mkOption {
            type = lib.types.str;
            default = "/home/test user";
          };
          options.xdg = {
            configHome = lib.mkOption {
              type = lib.types.str;
              default = "/home/test user/.config";
            };
            stateHome = lib.mkOption {
              type = lib.types.str;
              default = "/home/test user/.local/state";
            };
            cacheHome = lib.mkOption {
              type = lib.types.str;
              default = "/home/test user/.cache";
            };
          };
          options.systemd.user.services = attrs;
          options.assertions = lib.mkOption {
            type = lib.types.listOf lib.types.attrs;
            default = [ ];
          };
        }
        settings
      ];
    }).config;
  disabled = eval { };
  enabled = eval {
    services.ag-dash = {
      enable = true;
      inherit package;
    };
  };
  service = enabled.systemd.user.services.ag-dash;
  script = builtins.readFile service.Service.ExecStart;
  custom = eval {
    services.ag-dash = {
      enable = true;
      inherit package;
      bindAddress = "100.64.1.2";
      port = 7796;
      publicOrigin = "http://fleet.example.ts.net:7796";
      configFile = "/home/test user/config's 100%.yaml";
      tokenFile = "/home/test user/token link";
      cacheDirectory = "/home/test user/gallery";
      audioCacheDirectory = "/home/test user/audio cache";
      environment.SSH_AUTH_SOCK = "/run/user/1000/agent socket";
      refreshSeconds = 60;
      imageRefreshSeconds = 600;
      images = false;
      audio = false;
      tts = false;
      ttsLines = 7;
    };
  };
  customScript = builtins.readFile custom.systemd.user.services.ag-dash.Service.ExecStart;
  ipv6 = eval {
    services.ag-dash = {
      enable = true;
      inherit package;
      bindAddress = "::";
    };
  };
  wildcard = eval {
    services.ag-dash = {
      enable = true;
      inherit package;
      bindAddress = "0.0.0.0";
    };
  };
  badEnv = eval {
    services.ag-dash = {
      enable = true;
      inherit package;
      environment."BAD;echo" = "no";
    };
  };
in
assert disabled.systemd.user.services == { };
assert lib.all (a: a.assertion) enabled.assertions;
assert !(lib.all (a: a.assertion) badEnv.assertions);
assert service.Install.WantedBy == [ "default.target" ];
assert service.Service.Restart == "always";
assert service.Service.RestartSec == 5;
assert service.Unit.StartLimitIntervalSec == 0;
assert service.Service.KillMode == "control-group";
assert service.Service.KillSignal == "SIGTERM";
assert service.Service.UMask == "0077";
assert lib.hasInfix "--no-open --bind 127.0.0.1:7795" script;
assert lib.hasInfix "--token-file '/home/test user/.local/state/ag/dash/token'" script;
assert lib.hasInfix "--refresh 300 --image-refresh 300 --tts-lines 20" script;
assert !(lib.hasInfix "--no-tts" script);
assert lib.hasInfix "--no-tts" customScript;
assert lib.hasInfix "--bind 100.64.1.2:7796" customScript;
assert lib.hasInfix "--public-origin http://fleet.example.ts.net:7796" customScript;
assert lib.hasInfix "--no-images" customScript;
assert lib.hasInfix "--no-audio" customScript;
assert !(lib.hasInfix "--no-audio" script);
assert !(lib.hasInfix "--audio-cache-dir" script);
assert lib.hasInfix "export SSH_AUTH_SOCK='/run/user/1000/agent socket'" customScript;
assert lib.hasInfix "[::]:7795" (
  builtins.readFile ipv6.systemd.user.services.ag-dash.Service.ExecStart
);
assert lib.hasInfix "--bind 0.0.0.0:7795" (
  builtins.readFile wildcard.systemd.user.services.ag-dash.Service.ExecStart
);
pkgs.runCommand "ag-dash-home-manager-check" { nativeBuildInputs = [ package ]; } ''
    ${pkgs.bash}/bin/bash ${custom.systemd.user.services.ag-dash.Service.ExecStart} > actual
    cat > expected <<'EOF'
  --config
  /home/test user/config's 100%.yaml
  dash
  --no-open
  --bind
  100.64.1.2:7796
  --token-file
  /home/test user/token link
  --refresh
  60
  --image-refresh
  600
  --tts-lines
  7
  --public-origin
  http://fleet.example.ts.net:7796
  --cache-dir
  /home/test user/gallery
  --audio-cache-dir
  /home/test user/audio cache
  --no-images
  --no-audio
  --no-tts
  EOF
    diff -u expected actual
    touch "$out"
''
