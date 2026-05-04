# Changelog

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
