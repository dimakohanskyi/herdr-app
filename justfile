set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default:
    @just --list

notes-clip scene version="":
    bun scripts/notes-media.ts clip "{{scene}}" "{{version}}"

notes-upload version:
    bun scripts/notes-media.ts upload "{{version}}"

notes-check version:
    bun scripts/notes-media.ts check "{{version}}"

check: test

notices:
    bun scripts/notices.ts

# Before a release: tests, docs, the next version's notes and clips, then what
# changed since the last release, to review by hand.
[unix]
pre-release: test docs-check
    #!/usr/bin/env bash
    set -euo pipefail
    version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
    last=$(git describe --tags --abbrev=0 --match 'v*')
    if grep -q "^## \[$version\]" CHANGELOG.md; then
      bun scripts/notes-media.ts check "$version"
    else
      echo "note: CHANGELOG.md has no [$version] entry yet: write the release notes before tagging."
    fi
    echo; echo "Since $last:"; git log --oneline "$last"..HEAD
    echo
    if git diff --quiet "$last"..HEAD -- src/SKILL.md; then
      echo "review: the agent manual (herdr-app --skill, src/SKILL.md) is unchanged since $last. Does it still match the changes above?"
    else
      echo "review: the agent manual (herdr-app --skill) changed since $last. Read it once more."
    fi
    echo "review: the mod guide (defaults/AGENTS.md), README.md and docs/ describe the changes above."

build:
    cargo build --locked

test:
    bun test scripts/changes.test.ts scripts/files.test.ts scripts/machine-add.test.ts scripts/picker.test.ts scripts/palette.test.ts scripts/agents.test.ts scripts/spaces.test.ts scripts/mod-storage.test.ts scripts/worktree.test.ts scripts/settings.test.ts scripts/tabs.test.ts scripts/slack.test.ts scripts/pulse.test.ts scripts/notes.test.ts
    cargo test --locked

docs-generate: build
    bun scripts/docs.ts generate

# Copy the Slack token from Keychain into Copilot CLI's MCP config (rerun after reinstalling the Slack app).
[macos]
slack-token:
    #!/usr/bin/env bun
    import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const token = Bun.spawnSync(["security", "find-generic-password", "-s", "herdr-slack-mcp", "-w"]).stdout.toString().trim();
    if (!token.startsWith("xoxp-")) throw new Error("No xoxp- token in Keychain item herdr-slack-mcp.");
    const file = `${process.env.HOME}/.copilot/mcp-config.json`;
    const cfg = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    (cfg.mcpServers ??= {}).slack = { type: "http", url: "https://mcp.slack.com/mcp", headers: { Authorization: `Bearer ${token}` }, tools: ["*"] };
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    chmodSync(file, 0o600);
    console.log(`slack MCP token written to ${file}; restart Copilot CLI.`);

docs-check: build
    bun test scripts/docs.test.ts
    bun scripts/docs.ts check

[linux]
install:
    bash scripts/install-linux

[macos]
install:
    bash scripts/install-macos

# This Mac needs Zig 0.16 (Homebrew's is newer) and native arm64 Rust (the default runs under Rosetta).
# Production: test, then build and install the release into /Applications/Herdr.app.
[macos]
deploy:
    #!/usr/bin/env bash
    set -euo pipefail
    for dir in "$HOME/.local/zig-0.16.0" "$HOME/.rustup/toolchains/1.95.0-aarch64-apple-darwin/bin"; do [[ -d $dir ]] && PATH="$dir:$PATH"; done
    export PATH
    cargo test --locked
    HERDR_APP=/Applications/Herdr.app bash scripts/install-macos
    # One Herdr only: the dev copy `just install` puts in ~/Applications shares the bundle id.
    old="$HOME/Applications/Herdr.app"
    if [[ -d $old ]]; then
      /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$old" || true
      rm -rf "$old"
      echo "Removed $old."
    fi

[windows]
install:
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1
