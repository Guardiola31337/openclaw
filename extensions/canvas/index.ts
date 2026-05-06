import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { canvasConfigSchema } from "./src/config.js";
import { A2UI_PATH, CANVAS_HOST_PATH, CANVAS_WS_PATH } from "./src/host/a2ui.js";
import { createCanvasHttpRouteHandler } from "./src/http-route.js";
import { createCanvasTool } from "./src/tool.js";

const CANVAS_NODE_COMMANDS = [
  "canvas.present",
  "canvas.hide",
  "canvas.navigate",
  "canvas.eval",
  "canvas.snapshot",
  "canvas.a2ui.push",
  "canvas.a2ui.pushJSONL",
  "canvas.a2ui.reset",
];

export default definePluginEntry({
  id: "canvas",
  name: "Canvas",
  description: "Experimental Canvas control and A2UI rendering surfaces for paired nodes.",
  configSchema: canvasConfigSchema,
  reload: {
    restartPrefixes: ["plugins.enabled", "plugins.allow", "plugins.deny", "plugins.entries.canvas"],
  },
  register(api) {
    const httpRouteHandler = createCanvasHttpRouteHandler({
      config: api.config,
      pluginConfig: api.pluginConfig,
      runtime: {
        log: (...args) => api.logger.info(args.map(String).join(" ")),
        error: (...args) => api.logger.error(args.map(String).join(" ")),
        exit: (code) => {
          throw new Error(`canvas host requested process exit ${code}`);
        },
      },
    });
    api.registerHttpRoute({
      path: A2UI_PATH,
      auth: "plugin",
      match: "prefix",
      handler: httpRouteHandler.handleHttpRequest,
    });
    api.registerHttpRoute({
      path: CANVAS_HOST_PATH,
      auth: "plugin",
      match: "prefix",
      handler: httpRouteHandler.handleHttpRequest,
    });
    api.registerHttpRoute({
      path: CANVAS_WS_PATH,
      auth: "plugin",
      match: "exact",
      handler: httpRouteHandler.handleHttpRequest,
      handleUpgrade: httpRouteHandler.handleUpgrade,
    });
    api.registerService({
      id: "canvas-host",
      start: () => {},
      stop: () => httpRouteHandler.close(),
    });
    api.registerNodeInvokePolicy({
      commands: CANVAS_NODE_COMMANDS,
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: true,
      handle: (ctx) => ctx.invokeNode(),
    });
    api.registerTool((ctx) =>
      createCanvasTool({
        config: ctx.runtimeConfig ?? ctx.config,
        workspaceDir: ctx.workspaceDir,
      }),
    );
  },
});
