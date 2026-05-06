import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  getActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginChannelRegistry,
  releasePinnedPluginChannelRegistry,
  releasePinnedPluginHttpRouteRegistry,
  resetPluginRuntimeStateForTest,
  resolveActivePluginHttpRouteRegistry,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";

function createRegistryWithRoute(path: string) {
  const registry = createEmptyPluginRegistry();
  registry.httpRoutes.push({
    path,
    auth: "plugin",
    match: "exact",
    handler: () => true,
    pluginId: "demo",
    source: "test",
  });
  return registry;
}

describe("createGatewayRuntimeState", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    releasePinnedPluginHttpRouteRegistry();
    releasePinnedPluginChannelRegistry();
    resetPluginRuntimeStateForTest();
    return Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("releases post-bootstrap repinned plugin registries on cleanup", async () => {
    const startupRegistry = createRegistryWithRoute("/startup");
    const loadedRegistry = createRegistryWithRoute("/loaded");
    const fallbackRegistry = createRegistryWithRoute("/fallback");

    setActivePluginRegistry(startupRegistry);
    const runtimeState = await createGatewayRuntimeState({
      cfg: {},
      bindHost: "127.0.0.1",
      port: 0,
      controlUiEnabled: false,
      controlUiBasePath: "/",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth: {} as never,
      getResolvedAuth: () => ({}) as never,
      hooksConfig: () => null,
      getHookClientIpConfig: () => ({}) as never,
      pluginRegistry: startupRegistry,
      deps: {} as never,
      canvasRuntime: {} as never,
      canvasHostEnabled: false,
      logCanvas: { info: () => {}, warn: () => {} },
      log: { info: () => {}, warn: () => {} },
      logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });

    pinActivePluginHttpRouteRegistry(loadedRegistry);
    pinActivePluginChannelRegistry(loadedRegistry);
    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(loadedRegistry);
    expect(getActivePluginChannelRegistry()).toBe(loadedRegistry);

    runtimeState.releasePluginRouteRegistry();

    expect(resolveActivePluginHttpRouteRegistry(fallbackRegistry)).toBe(startupRegistry);
    expect(getActivePluginChannelRegistry()).toBe(startupRegistry);
  });

  it("creates the canvas host without logging it before HTTP bind", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-runtime-"));
    tempDirs.push(root);
    const registry = createEmptyPluginRegistry();
    const logCanvas = { info: vi.fn(), warn: vi.fn() };

    const runtimeState = await createGatewayRuntimeState({
      cfg: { canvasHost: { root, liveReload: false } },
      bindHost: "127.0.0.1",
      port: 18789,
      controlUiEnabled: false,
      controlUiBasePath: "/",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth: {} as never,
      getResolvedAuth: () => ({}) as never,
      hooksConfig: () => null,
      getHookClientIpConfig: () => ({}) as never,
      pluginRegistry: registry,
      deps: {} as never,
      canvasRuntime: { log: () => {} } as never,
      canvasHostEnabled: true,
      allowCanvasHostInTests: true,
      logCanvas,
      log: { info: () => {}, warn: () => {} },
      logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });

    expect(runtimeState.canvasHost?.rootDir).toBe(root);
    expect(logCanvas.info).not.toHaveBeenCalled();
    await runtimeState.canvasHost?.close();
  });

  it("reads canvas host root from plugin config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-canvas-plugin-runtime-"));
    tempDirs.push(root);
    const registry = createEmptyPluginRegistry();

    const runtimeState = await createGatewayRuntimeState({
      cfg: {
        canvasHost: { root: "/legacy", liveReload: true },
        plugins: {
          entries: {
            canvas: {
              config: {
                host: { root, liveReload: false },
              },
            },
          },
        },
      },
      bindHost: "127.0.0.1",
      port: 18789,
      controlUiEnabled: false,
      controlUiBasePath: "/",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      resolvedAuth: {} as never,
      getResolvedAuth: () => ({}) as never,
      hooksConfig: () => null,
      getHookClientIpConfig: () => ({}) as never,
      pluginRegistry: registry,
      deps: {} as never,
      canvasRuntime: { log: () => {} } as never,
      canvasHostEnabled: true,
      allowCanvasHostInTests: true,
      logCanvas: { info: () => {}, warn: () => {} },
      log: { info: () => {}, warn: () => {} },
      logHooks: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
      logPlugins: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
    });

    expect(runtimeState.canvasHost?.rootDir).toBe(root);
    await runtimeState.canvasHost?.close();
  });
});
