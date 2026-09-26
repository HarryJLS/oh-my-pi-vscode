import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import vm from "node:vm";

import { DEFAULT_TERMINAL_SETTINGS } from "../src/appearance";
import { buildTerminalHtml, clearAssetCache } from "../src/terminal/terminalHtml";

const SETTINGS = { ...DEFAULT_TERMINAL_SETTINGS, macOptionIsMeta: true };

describe("buildTerminalHtml", () => {
  it("returns ok html when assets exist", () => {
    clearAssetCache();
    const extensionPath = path.resolve(import.meta.dirname, "..");
    const result = buildTerminalHtml(extensionPath, SETTINGS);

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.html, /xterm/);
      assert.match(result.html, /SearchAddon/);
      assert.match(result.html, /search-bar/);
      assert.match(result.html, /readXtermTheme/);
      assert.match(result.html, /applyTheme/);
      assert.match(result.html, /vscode-terminal-background/);
      assert.match(result.html, /acquireVsCodeApi/);
      // Shift+Enter must inject a newline sequence (xterm.js drops shiftKey for Enter).
      assert.match(result.html, /e\.shiftKey/);
      assert.match(result.html, /\\x1b\[13;2~/);
      // Preserve macOS terminal semantics: Cmd+Backspace sends Ctrl+U.
      assert.match(result.html, /e\.metaKey.*e\.key === 'Backspace'/s);
      assert.match(result.html, /data: '\\x15'/);
    }
  });

  it("inline webview script is syntactically valid", () => {
    clearAssetCache();
    const extensionPath = path.resolve(import.meta.dirname, "..");
    const result = buildTerminalHtml(extensionPath, SETTINGS);
    assert.equal(result.ok, true);
    if (result.ok) {
      // Extract the last nonce'd <script> (the inline app code) and confirm it
      // parses. Guards against template-literal escape sequences (e.g. a bare
      // \r in a // comment) that silently corrupt the webview and blank the TUI.
      const scripts = [...result.html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)].map(
        (m) => m[1],
      );
      const appScript = scripts[scripts.length - 1];
      assert.ok(appScript, "inline app script not found");
      assert.doesNotThrow(() => new vm.Script(appScript!, { filename: "webview-app.js" }));
    }
  });

  it("passes macOptionIsMeta through to the xterm Terminal options", () => {
    clearAssetCache();
    const extensionPath = path.resolve(import.meta.dirname, "..");
    const off = buildTerminalHtml(extensionPath, {
      ...DEFAULT_TERMINAL_SETTINGS,
      macOptionIsMeta: false,
    });
    const on = buildTerminalHtml(extensionPath, {
      ...DEFAULT_TERMINAL_SETTINGS,
      macOptionIsMeta: true,
    });

    assert.equal(off.ok, true);
    assert.equal(on.ok, true);
    if (off.ok && on.ok) {
      assert.match(off.html, /macOptionIsMeta: false/);
      assert.match(on.html, /macOptionIsMeta: true/);
    }
  });

  it("returns error html when assets are missing", () => {
    clearAssetCache();
    const result = buildTerminalHtml("/nonexistent/path", SETTINGS);

    assert.equal(result.ok, false);
    assert.match(result.html, /Failed to load terminal assets/);
  });
});
