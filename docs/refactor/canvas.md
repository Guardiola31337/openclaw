---
summary: "Plan and audit checklist for moving Canvas out of core and into a bundled experimental plugin."
read_when:
  - Moving Canvas host, tools, commands, docs, or protocol ownership
  - Auditing whether Canvas is still core-owned
  - Preparing or reviewing the experimental Canvas plugin PR
title: "Canvas plugin refactor"
---

# Canvas plugin refactor

Canvas is low-use and experimental. Treat it as a bundled plugin, not a core feature. Core may keep generic gateway, node, HTTP, auth, config, and native-client plumbing, but Canvas-specific behavior should live under `extensions/canvas`.

## Goal

Move Canvas ownership to `extensions/canvas` while preserving the current paired-node behavior:

- the agent-facing `canvas` tool is registered by the Canvas plugin
- Canvas node commands are allowed only when the Canvas plugin registers them
- A2UI host/source files live under the Canvas plugin
- Canvas document materialization lives under the Canvas plugin
- CLI command implementation lives under the Canvas plugin, or delegates through a plugin-owned runtime barrel
- docs and plugin inventory describe Canvas as experimental and plugin-backed

## Non-goals

- Do not redesign the native app Canvas UI in this refactor.
- Do not remove Canvas protocol/client support from iOS, Android, or macOS unless a separate product decision says Canvas should be deleted.
- Do not build a broad plugin service framework only for Canvas unless at least one other bundled plugin needs the same seam.

## Current branch state

Done:

- Added bundled plugin package in `extensions/canvas`.
- Added `extensions/canvas/openclaw.plugin.json`.
- Moved the agent `canvas` tool from `src/agents/tools/canvas-tool.ts` to `extensions/canvas/src/tool.ts`.
- Removed core registration of `createCanvasTool` from `src/agents/openclaw-tools.ts`.
- Moved Canvas host implementation from `src/canvas-host` to `extensions/canvas/src/host`.
- Added `extensions/canvas/runtime-api.ts` as the plugin-owned runtime barrel used by core gateway code.
- Moved Canvas document materialization from `src/gateway/canvas-documents.ts` to `extensions/canvas/src/documents.ts`.
- Moved Canvas CLI implementation and A2UI JSONL helpers into `extensions/canvas/src/cli.ts`.
- Moved Canvas host URL and scoped capability helpers into `extensions/canvas/src`.
- Moved Canvas node command defaults out of hardcoded core lists and into plugin `nodeInvokePolicies`.
- Added plugin-owned Canvas host config at `plugins.entries.canvas.config.host`.
- Kept top-level `canvasHost` as a legacy compatibility alias while new config moves to the Canvas plugin entry.
- Updated generated plugin inventory to include Canvas.
- Added plugin reference docs at `docs/plugins/reference/canvas.md`.

Known remaining core-owned Canvas surfaces:

- `src/cli/nodes-cli/register.canvas.ts` remains as a compatibility shim because the current plugin CLI registry owns top-level commands, while Canvas is nested under `nodes canvas`
- `src/config/types.gateway.ts` and related schema labels/help retain legacy `canvasHost` compatibility
- native app Canvas protocol/client handlers under `apps/`

## Target shape

`extensions/canvas` should own:

- plugin manifest and package metadata
- agent tool registration
- node invoke command policy
- Canvas host and A2UI runtime
- Canvas document creation and asset resolution
- Canvas CLI implementation
- Canvas docs page and plugin inventory entry

Core should own only generic seams:

- plugin discovery and registration
- generic agent tool registry
- generic node invoke policy registry
- generic gateway HTTP/auth dispatch
- generic node capability transport
- generic config plumbing plus the legacy `canvasHost` alias for existing Canvas config

Native apps may keep Canvas command handlers as clients of the protocol. They are not the plugin runtime owner.

## Migration steps

1. Treat `plugins.entries.canvas.config.host` as the plugin-owned config surface.
2. Keep `canvasHost` as a read-only compatibility alias until a later migration/doctor pass can rewrite existing configs.
3. Update docs so Canvas is described as an experimental bundled plugin.
4. Run focused Canvas tests, plugin inventory checks, plugin SDK API checks, and build/type gates affected by runtime boundaries.

## Audit checklist

Before calling the refactor complete:

- `rg "src/canvas-host|../canvas-host"` returns no live source imports.
- `rg "canvas-tool|createCanvasTool" src` finds no core-owned Canvas tool implementation.
- `rg "canvas.present|canvas.snapshot|canvas.a2ui" src/gateway` finds no hardcoded allowlist defaults outside generic plugin policy tests.
- `rg "canvas-documents" src` is either empty or only imports the Canvas plugin runtime barrel.
- `rg "registerNodesCanvasCommands|nodes-canvas" src` is either empty or only a compatibility shim that delegates to the Canvas plugin.
- `pnpm plugins:inventory:check` passes.
- `pnpm plugin-sdk:api:check` passes, or generated API baselines are intentionally updated and reviewed.
- Targeted Canvas tests pass.
- Changed-lanes tests pass for Canvas host/A2UI paths.
- PR body explicitly says Canvas is experimental and plugin-backed.

## Verification commands

Use targeted local checks while iterating:

```sh
pnpm test extensions/canvas/src/host/server.test.ts extensions/canvas/src/host/server.state-dir.test.ts extensions/canvas/src/host/file-resolver.test.ts
pnpm test src/gateway/server.canvas-auth.test.ts src/gateway/server-import-boundary.test.ts
pnpm test test/scripts/changed-lanes.test.ts test/scripts/bundle-a2ui.test.ts
pnpm tsgo:extensions
pnpm plugins:inventory:check
pnpm plugin-sdk:api:check
```

Run `pnpm build` before push if runtime barrel, lazy import, packaging, or published plugin surfaces change.
