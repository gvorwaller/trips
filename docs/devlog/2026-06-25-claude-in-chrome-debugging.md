# Claude-in-Chrome MCP Debugging Session — 2026-06-25

## Problem

`mcp__claude-in-chrome__tabs_context_mcp` returns "Browser extension is not connected" in the trips project. Chrome extension (v1.0.77) is installed, enabled, site access "On all sites."

## What worked before

Session `1bd9137c` in the birds project (June 20, CLI 2.1.174) successfully used chrome tools — created tabs, navigated to `localhost:5178`, took screenshots. Same machine, same Chrome, same extension, same `ANTHROPIC_API_KEY` in `~/.zshrc`.

## Investigation timeline

### 1. Native messaging host wrapper — stale version (red herring)

`~/.claude/chrome/chrome-native-host` is a shell wrapper that execs the Claude binary with `--chrome-native-host`. It pointed to version `2.1.190` while the current CLI was `2.1.191`. Updated it to `2.1.191`. Restarted Chrome. **No effect.**

In hindsight this was irrelevant — Chrome wasn't even using this wrapper (see #2).

### 2. Two competing native messaging host registrations

Two JSON files in `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` both claim the same extension ID (`fcoeoabgfenejglbffodgkkbkcdhcgfn`):

- `com.anthropic.claude_browser_extension.json` — path: `/Applications/Claude.app/Contents/Helpers/chrome-native-host` (Claude desktop app)
- `com.anthropic.claude_code_browser_extension.json` — path: `~/.claude/chrome/chrome-native-host` (Claude Code CLI)

Chrome was launching the **desktop app's** native host (confirmed via `ps aux`). Temporarily renamed the desktop app's JSON to `.bak`, restarted Chrome. The CLI's native host then launched instead (confirmed: PID matched CLI binary `2.1.191`). **Still no MCP connection.**

Restored the desktop app's JSON after testing.

### 3. Socket connectivity — verified working

The native host creates a Unix socket at `/tmp/claude-mcp-browser-bridge-gaylonvorwaller/<PID>.sock`. Verified with Python that the socket accepts connections. The native host process runs correctly and listens. **The bridge exists; the MCP client isn't connecting to it.**

### 4. Session timing

Suspected the MCP client attempted connection at session start before the socket existed (Chrome was restarted mid-session). Exited Claude Code, resumed with `claude --resume`. **Still no connection.**

### 5. Extension site permissions

Checked Chrome extension settings — "Site access" is set to "On all sites." Not the issue.

### 6. Root cause found: ANTHROPIC_API_KEY disables claude.ai connectors

`claude mcp list` output:

```
⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set
  and takes precedence over your claude.ai login · Unset it to load your organization's connectors

claude-relay: node /Users/gaylonvorwaller/claude-relay/mcp-server.js - ✔ Connected
```

The chrome extension is a **claude.ai connector**, not a regular MCP server. When `ANTHROPIC_API_KEY` is in the environment, CLI 2.1.191 uses API-key auth and disables all claude.ai connectors. This is a newer restriction — CLI 2.1.174 (June 20) didn't enforce it.

The key was added to `~/.zshrc` line 357 on 2026-04-28 for gmailwiz (which reads it from `os.environ`).

## Fix applied

**Applied — Claude Code settings override:**
Added to `~/.claude/settings.json`:
```json
"env": { "ANTHROPIC_API_KEY": "" }
```
Claude Code ignores the shell key and falls back to claude.ai login. Everything else (gmailwiz, trips dev server, etc.) still reads the key from the shell. One line, scoped to Claude Code only. Takes effect on next session start.

**Applied — trips `.env` for dev server:**
The `settings.json` override blanks `ANTHROPIC_API_KEY` inside Claude Code's Bash environment. The trips dev server (SvelteKit/Vite) auto-loads `.env`, so extraction features (`itinerary-extract.ts`, `reservation-extract.ts`, `expense-extract.ts`) need the key there. Created `/Users/gaylonvorwaller/trips/.env` (gitignored) with the key. Prod is unaffected — `/opt/trips/.env` on the droplet has its own copy.

**Not applied — gmailwiz `.env`:**
gmailwiz reads `os.environ` directly (no `python-dotenv`), so a `.env` file wouldn't be loaded. gmailwiz works from the user's normal terminal (`~/.zshrc` exports the key) but won't work if run from Claude Code's Bash. Acceptable since gmailwiz is always run from the user's own shell.

## Resolution (same-day follow-up session)

Three fixes were all required:

1. **`ANTHROPIC_API_KEY` cleared** — the `settings.json` env override from above. Without this, claude.ai connectors (including the Chrome extension) are disabled.

2. **Desktop app native messaging host disabled** — renamed `com.anthropic.claude_browser_extension.json` to `.bak` permanently. Chrome was launching the desktop app's native host (`/Applications/Claude.app/Contents/Helpers/chrome-native-host`) instead of the CLI's wrapper. The desktop app's host creates a bridge socket but needs the desktop app running to relay — since we never run the desktop app, the bridge was dead. With only `com.anthropic.claude_code_browser_extension.json` remaining, Chrome uses the CLI's host (`~/.local/share/claude/versions/2.1.191 --chrome-native-host`).

3. **Extension login** — clicking the Claude extension icon in Chrome's toolbar triggered a separate auth flow (`claude.ai/chrome/installed`). Being logged into claude.ai in the browser was NOT enough; the extension needed its own activation. Without this, the extension service worker was completely dormant (zero console output, zero network activity). This was the missing piece from the earlier session — fixes #1 and #2 were in place but the extension had never been activated.

After all three: `list_connected_browsers` returned the local Chrome, `tabs_context_mcp` returned tabs, navigation and screenshots work.

## Prod impact: none

Prod (`/opt/trips/.env` on the droplet at 134.199.211.199) has its own `ANTHROPIC_API_KEY` — verified via SSH. The `settings.json` override only affects the local Claude Code process. The deploy script (`scripts/deploy-to-DO.sh`) never touches `.env` on the droplet.

## Files changed

- `~/.claude/settings.json` — added `"env": { "ANTHROPIC_API_KEY": "" }`
- `~/.claude/chrome/chrome-native-host` — updated version `2.1.190` → `2.1.191` (cosmetic)
- `~/Library/.../com.anthropic.claude_browser_extension.json` — renamed to `.bak` (permanent; desktop app host not needed)
- `/Users/gaylonvorwaller/trips/.env` — created with `ANTHROPIC_API_KEY` so dev server extraction works regardless of launch context (gitignored)

## New features tested this session

### Import from Google Maps link
- New `<details>` accordion: paste a Google Maps URL, click "Extract place"
- `src/lib/server/google-maps-url.ts` (new) — parses `/maps/place/Name/@lat,lng`, `/maps/@lat,lng`, `?q=lat,lng`, and `maps.app.goo.gl` short links
- Server action `itin-extract-url` validates the URL, calls `extractItineraryFromGoogleMapsUrl()`, geocodes if needed
- Tested with Musée du Louvre URL — correctly extracted name and coordinates

### Import from photo
- New `<details>` accordion: upload a photo, click "Identify place"
- `extractItineraryFromImage()` sends base64 image to Anthropic vision API with `IMAGE_SYSTEM_PROMPT`
- Server action `itin-extract-image` validates file (20 MB limit, image mime types), base64-encodes, calls extractor
- Tested with Florida Theatre (Jacksonville) photo — correctly identified name, address (128 E Forsyth St), and location

### Candidate panel UX fix
- Moved the candidate review panel from inside the "Import itinerary from text" `<details>` block to after all three import accordions (text, Google Maps link, photo)
- Previously, extracting via URL or photo required manually opening the text import accordion to see candidates

### Google Maps API key referrer fix
- Map on trip page showed `RefererNotAllowedMapError` because the key only had `http://127.0.0.1:5179/*` but browser uses `localhost`
- Added `http://localhost:5179/*` and `http://localhost:5178/*` to Maps Platform API Key referrers in gaylonphotos GCP project

### Dev server ANTHROPIC_API_KEY gotcha
- Dev server started from Claude Code's Bash inherits `ANTHROPIC_API_KEY=""` (from `settings.json` env override)
- Vite's `process.env` takes precedence over `.env.test`, masking the real key
- Fix: prefix with `ANTHROPIC_API_KEY=sk-ant-... npm run dev:test`, or start from user's terminal
- Added to global `~/.claude/CLAUDE.md` as operational knowledge
