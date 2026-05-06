import { describe, expect, it } from "vitest";
import {
  isCanvasHostEnabled,
  isCanvasPluginEnabled,
  parseCanvasPluginConfig,
  resolveCanvasHostConfig,
} from "./config.js";

describe("Canvas plugin config", () => {
  it("parses host config from the plugin entry", () => {
    expect(
      parseCanvasPluginConfig({
        host: {
          enabled: false,
          root: "~/canvas",
          port: 18793,
          liveReload: false,
          ignored: true,
        },
      }),
    ).toEqual({
      host: {
        enabled: false,
        root: "~/canvas",
        port: 18793,
        liveReload: false,
      },
    });
  });

  it("prefers plugin host config over the legacy canvasHost alias", () => {
    expect(
      resolveCanvasHostConfig({
        config: {
          canvasHost: {
            enabled: true,
            root: "/legacy",
            liveReload: true,
          },
          plugins: {
            entries: {
              canvas: {
                config: {
                  host: {
                    enabled: false,
                    root: "/plugin",
                    liveReload: false,
                  },
                },
              },
            },
          },
        },
      }),
    ).toEqual({
      enabled: false,
      root: "/plugin",
      liveReload: false,
    });
  });

  it("disables the host when the bundled Canvas plugin is disabled", () => {
    const config = {
      plugins: {
        entries: {
          canvas: {
            enabled: false,
          },
        },
      },
    };
    expect(isCanvasPluginEnabled(config)).toBe(false);
    expect(isCanvasHostEnabled(config)).toBe(false);
  });
});
