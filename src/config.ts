import * as fs from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";

import { DEFAULT_TERMINAL_SETTINGS, type TerminalSettings } from "./appearance";

export function getExecutable(): string {
  const config = vscode.workspace.getConfiguration("ohMyPi");
  const value = config.get<string>("executablePath")?.trim();
  return value || "omp";
}

export function getProfile(): string {
  const config = vscode.workspace.getConfiguration("ohMyPi");
  return config.get<string>("profile")?.trim() || "";
}

function getWorkingDirectory(): string {
  const config = vscode.workspace.getConfiguration("ohMyPi");
  const configured = config.get<string>("workingDirectory")?.trim();
  if (configured) {
    return configured;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || os.homedir();
}

export function resolveWorkingDirectory(): string {
  const cwd = getWorkingDirectory();

  try {
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      return cwd;
    }
  } catch {
    // fall through to home
  }

  return os.homedir();
}

/**
 * Terminal appearance/behaviour mirrored from VS Code's `terminal.integrated.*`
 * settings, so the embedded panel matches the built-in terminal.
 */
export function getTerminalSettings(): TerminalSettings {
  const config = vscode.workspace.getConfiguration("terminal.integrated");
  return {
    family: config.get<string>("fontFamily") || DEFAULT_TERMINAL_SETTINGS.family,
    size: config.get<number>("fontSize") ?? DEFAULT_TERMINAL_SETTINGS.size,
    macOptionIsMeta:
      config.get<boolean>("macOptionIsMeta") ?? DEFAULT_TERMINAL_SETTINGS.macOptionIsMeta,
  };
}

/**
 * The workbench command that hides the region the panel sits in.
 *
 * VS Code exposes no API for a view's location, and every "close" command
 * targets one fixed part, so the user points at the part the panel lives in.
 * `workbench.action.closeSidebar` is the default because a container
 * contributed through `viewsContainers.activitybar` starts in the primary side
 * bar.
 */
const CLOSE_COMMAND_BY_PANEL_LOCATION: Record<string, string> = {
  primary: "workbench.action.closeSidebar",
  secondary: "workbench.action.closeAuxiliaryBar",
  panel: "workbench.action.closePanel",
};

export function getPanelCloseCommand(): string {
  const configured = vscode.workspace.getConfiguration("ohMyPi").get<string>("panelLocation");
  return (
    (configured && CLOSE_COMMAND_BY_PANEL_LOCATION[configured]) ??
    CLOSE_COMMAND_BY_PANEL_LOCATION.primary
  );
}
