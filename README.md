# Smart Title Plugin

Auto-generates meaningful session titles for your OpenCode conversations using AI.

It also syncs your terminal window title with the current project and session activity.

## What It Does

- Watches your conversation and generates short, descriptive titles
- Updates automatically when the session becomes idle (you stop typing)
- Syncs the terminal title as `<project> : <status>`
- Shows activity with emoji states like `🟢 running` and `💤 idle`
- Avoids redundant title writes and repeated session lookups during event bursts
- Uses OpenCode's unified auth - no API keys needed
- Works with any authenticated AI provider

## Installation

```bash
npm install @jc01rho/opencode-smart-title
```

Add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["@jc01rho/opencode-smart-title"]
}
```

## Configuration

The plugin supports both global and project-level configuration:

- **Global:** `~/.config/opencode/smart-title.jsonc` - Applies to all sessions
- **Project:** `.opencode/smart-title.jsonc` - Overrides global config

The plugin creates a default global config on first run.

```jsonc
{
  // Enable or disable the plugin
  "enabled": true,

  // Enable debug logging
  "debug": false,

  // Optional: Use a specific model (otherwise uses smart fallbacks)
  // "model": "anthropic/claude-haiku-4-5",

  // Update title every N idle events (1 = every time you pause)
  "updateThreshold": 1
}
```

## Terminal Title Behavior

- Terminal title updates are best-effort and depend on your terminal supporting OSC title sequences
- The plugin prefers TTY-safe writes and includes tmux/screen-compatible wrapping when needed
- Running status is shown as `🟢`
- Subagent-only activity while the main session is idle is shown as `🤖`
- Idle status is shown as `💤`

## GitHub Actions Publish

This repository includes GitHub Actions for CI and npm publishing.

- `ci.yml` runs `npm run typecheck` and `npm run build` on pushes and pull requests to `master`
- `publish.yml` runs on `v*` tag pushes and can also be started manually with a `tag_name` input; it checks that the tag matches `package.json.version`, creates the matching GitHub Release if needed, and then publishes to npm
- Add an `NPM_TOKEN` repository secret in GitHub Actions settings before using the publish workflow
- Keep the `package.json` version updated before pushing the `v*` tag that should create the GitHub Release and publish to npm

## License

MIT
