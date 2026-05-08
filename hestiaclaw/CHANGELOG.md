# Changelog

## 1.0.23

- Fix: Home Assistant tools were invisible to the model when `agent.config.json` carried the legacy `modelVisible: false` (or `role`) field on an MCP server entry. That mechanism existed to hide HA tools from the model while the orchestrator owned them; with the orchestrator removed, it just suppresses every HA tool. Both fields are now ignored with a one-line deprecation warning at startup; remove them from `agent.config.json` to silence it. Native `home-assistant__*` tools now show up in the policy editor and are callable.
- Fix Agent Harness panel: hide the legacy "Allow all tools / Tool Filter" UI when the Tool Policy section is active so they don't render side-by-side. Style the Tool Policy list properly (no more truncated `read_me…` names; profile description rendered in a muted info color instead of the warning amber). Per-tool approval-mode dropdown is now wide enough to read.

## 1.0.22

- Replace the Home Assistant facade with native ha-mcp tool exposure plus a new harness-level Tool Policy layer. The custom `ha_get_area_summary` builtin and any associated resolver code have been removed; the model now talks to ha-mcp tools directly and is told to search/list state before issuing service calls.
- Add Tool Profiles (Minimal, Home Control, Full Agent, Developer, Custom) selectable from the Agent Harness panel. Each profile decides which tools are visible and provides per-source defaults (e.g. block high-risk tools from voice/webhook).
- Add per-tool approval modes (`never` / `writes` / `always` / `block` / `default`) and per-tool `allowedSources` overrides, persisted under `harness.toolPolicy` in `agent.config.json`.
- For OpenAI, send the full tool list every turn and use `tool_choice.allowed_tools` to restrict the active subset, so the cached tools-prefix stays stable across turns even as policy narrows what the model may call.
- New endpoints: `GET /api/agent/tool-profiles`, `GET/PUT /api/agent/tool-policy`. Webhook (HA voice) now runs with `source: webhook` so source-aware policy rules apply.

## 1.0.10

- Fix blank local ingress page at `/ee1bc088_hestiaclaw` without a trailing slash by injecting an HTML `<base>` tag before relative asset URLs are parsed

## 1.0.9

- Fix local HA ingress paths that are forwarded to the add-on with the `/ee1bc088_hestiaclaw` prefix still attached; the server now strips HA ingress prefixes before route matching, and the frontend falls back to the current path prefix when `X-Ingress-Path` is missing

## 1.0.8

- Fix session cookie on local HTTP — HA Supervisor's ingress always sets `X-Forwarded-Proto: https` regardless of actual protocol, causing `secure:auto` to drop cookies on local HTTP access; set `secure: false` explicitly since the add-on is already behind HA's own auth layer

## 1.0.7

- Fix session cookie on local network — use `secure: auto` so cookies work over HTTP (local) and HTTPS (external/Nabu Casa) without manual configuration

## 1.0.6

- Add `ha_token` config option — supply a long-lived HA access token directly instead of relying on the Supervisor token; fixes "invalid authentication token" errors when calling HA tools

## 1.0.5

- Fix ha-mcp connection race — replace fixed 2s sleep with a readiness probe that waits until ha-mcp is actually accepting connections before starting the Node server

## 1.0.4

- Fix password sync — admin password is now re-read from config on every restart so changing it in the add-on settings takes effect immediately
- Fix HA Ingress — API requests from the frontend are correctly rewritten to include the ingress path prefix

## 1.0.3

- Fix HA Ingress path injection — the `X-Ingress-Path` header is now injected into `index.html` so the frontend routes API calls through the ingress proxy correctly

## 1.0.2

- Fix ha-mcp startup — install Python 3.13 via `uv` at build time; Alpine's system Python (3.12) is incompatible with ha-mcp
- Auto-generate a random admin password on first start if none is configured (printed to the add-on log)

## 1.0.1

- Fix Docker build — restructure app source into the `hestiaclaw/` subdirectory so HA Supervisor can use it as the build context

## 1.0.0

- Initial Home Assistant add-on release
- Native HA connection via Supervisor token (no manual token setup)
- Bundled ha-mcp server for 87+ Home Assistant tools
- HA Ingress support — accessible directly from the HA sidebar
- NDJSON streaming support through Ingress proxy (`ingress_stream: true`)
- Optional Graphiti long-term memory via companion add-on
- Optional Neo4j knowledge graph via companion add-on
- Optional ElevenLabs voice I/O
- Optional SearXNG web search
