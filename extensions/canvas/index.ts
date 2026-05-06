import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { canvasConfigSchema } from "./src/config.js";
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
