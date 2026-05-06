import type { Command } from "commander";
import {
  registerNodesCanvasCommands as registerCanvasPluginNodesCanvasCommands,
  type CanvasCliDependencies,
} from "../../../extensions/canvas/runtime-api.js";
import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { writeBase64ToFile } from "../nodes-camera.js";
import { parseTimeoutMs } from "../parse-timeout.js";
import { getNodesTheme, runNodesCommand } from "./cli-utils.js";
import { buildNodeInvokeParams, callGatewayCli, nodesCallOpts, resolveNodeId } from "./rpc.js";

const canvasCliDependencies: CanvasCliDependencies = {
  defaultRuntime,
  nodesCallOpts,
  runNodesCommand,
  getNodesTheme,
  parseTimeoutMs,
  resolveNodeId,
  buildNodeInvokeParams,
  callGatewayCli,
  writeBase64ToFile,
  shortenHomePath,
};

export function registerNodesCanvasCommands(nodes: Command) {
  registerCanvasPluginNodesCanvasCommands(nodes, canvasCliDependencies);
}
