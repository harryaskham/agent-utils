{
  description = "annum — deterministic Outlook + Teams Kittui client, CLI, MCP server, cache, and daemon";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
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
      url = "git+ssh://git@github.com/harryaskham/remote-cli?rev=046740f5f696e7d5adc5b1776acff3078a781945";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.flake-utils.follows = "flake-utils";
    };
  };

  outputs = { self, nixpkgs, flake-utils, kittui-src, mcp-cli-src, configurable-cli-src, remote-cli, ... }:
    let
      remoteModules = remote-cli.lib.mkDaemonModules {
        packageFor = pkgs: self.packages.${pkgs.system}.annum;
        appName = "annum";
        displayName = "Annum";
        binary = "annum";
        defaultBind = "127.0.0.1:7621";
        description = "Annum Outlook and Teams WorkIQ cache collector";
      };
      perSystem = flake-utils.lib.eachDefaultSystem (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          patchedSrc = pkgs.runCommand "annum-source" { } ''
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
              --replace-fail 'remote-cli = { git = "https://github.com/harryaskham/remote-cli", rev = "046740f5f696e7d5adc5b1776acff3078a781945" }' \
                             'remote-cli = { path = "${remote-cli}" }'
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
          annum = pkgs.rustPlatform.buildRustPackage {
            pname = "annum";
            version = "0.1.0";
            src = patchedSrc;
            cargoHash = "sha256-LnFgjgmdNxlpVmQ79LusEz1Xl6D7esEizb92Wv3/LeY=";
            strictDeps = true;
            nativeBuildInputs = [ pkgs.makeWrapper ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
            postInstall = ''
              wrapProgram "$out/bin/annum" --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.nodejs ]}
            '';
            doCheck = true;
            meta = {
              description = "Deterministic Outlook and Teams Kittui client, CLI, MCP server, cache, and daemon";
              homepage = "https://github.com/harryaskham/agent-utils/tree/main/annum";
              license = pkgs.lib.licenses.mit;
              mainProgram = "annum";
              platforms = pkgs.lib.platforms.unix;
            };
          };
        in
        {
          packages = { inherit annum; default = annum; };
          apps = { annum = flake-utils.lib.mkApp { drv = annum; }; default = self.apps.${system}.annum; };
          devShells.default = pkgs.mkShell {
            packages = [ pkgs.cargo pkgs.rustc pkgs.rustfmt pkgs.clippy pkgs.pkg-config pkgs.nodejs ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
          };
        }
      );
    in
    perSystem // {
      nixosModules.default = remoteModules.nixos;
      nixosModules.annum = remoteModules.nixos;
      darwinModules.default = remoteModules.darwin;
      darwinModules.annum = remoteModules.darwin;
      nixOnDroidModules.default = remoteModules.nixOnDroid;
      nixOnDroidModules.annum = remoteModules.nixOnDroid;
    };
}
