import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import * as esbuild from "esbuild";

/**
 * Drives the real `activate()` wiring against a stub `vscode` module so the
 * editor keybinding path (Control+L -> ohMyPi.sendSelectedLinesOrToggle) is
 * exercised end to end without an Extension Host.
 */

const STUB_SOURCE = `
export const executed = [];
export const registered = new Map();
export const providers = new Map();
/** Settings the extension reads, keyed by "<section>.<name>". */
export const settings = {};

export const commands = {
  registerCommand(name, cb) {
    registered.set(name, cb);
    return { dispose() {} };
  },
  executeCommand(name) {
    executed.push(name);
    return Promise.resolve();
  },
};

export const window = {
  activeTextEditor: undefined,
  registerWebviewViewProvider(type, provider) {
    providers.set(type, provider);
    return { dispose() {} };
  },
  onDidChangeActiveColorTheme() {
    return { dispose() {} };
  },
  showErrorMessage() {
    return Promise.resolve(undefined);
  },
  showTextDocument() {
    return Promise.resolve({ selection: undefined, revealRange() {} });
  },
};

export const workspace = {
  workspaceFolders: [{ uri: { fsPath: process.cwd(), scheme: "file" } }],
  getConfiguration(section) {
    return { get: (key) => settings[section + "." + key] };
  },
  onDidChangeConfiguration() {
    return { dispose() {} };
  },
  asRelativePath(p) {
    return typeof p === "string" ? p : p.fsPath;
  },
  openTextDocument() {
    return Promise.resolve({ lineCount: 1 });
  },
};

export class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(p) {
    return new Uri(p);
  }
}

export const env = { openExternal() {} };
export class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}
export class Selection {
  constructor(a, b) {
    this.start = a;
    this.end = b;
  }
}
export class Range {
  constructor(a, b) {
    this.start = a;
    this.end = b;
  }
}
export const TextEditorRevealType = { InCenter: 2 };
`;

type FakeVscode = {
  executed: string[];
  registered: Map<string, () => unknown>;
  providers: Map<string, FakeProvider>;
  settings: Record<string, unknown>;
  window: { activeTextEditor: unknown };
};

type FakeProvider = {
  send(data: string): void;
  resolveWebviewView(webviewView: unknown, context: unknown, token: unknown): void;
  dispose(): void;
};

/**
 * The stub and the bundled extension live in a temp directory chosen at
 * runtime, so a static import specifier is impossible here.
 */
async function importRuntimeModule<T>(filePath: string): Promise<T> {
  return (await import(pathToFileURL(filePath).href)) as T;
}

/** Builds src/extension.ts with `vscode` swapped for the stub. */
async function loadExtension(): Promise<{ fake: FakeVscode; activate: (context: unknown) => void }> {
  // Kept inside the repository so Node resolves `@lydell/node-pty` (left
  // external) from the workspace's node_modules; removed once loaded.
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const outdir = mkdtempSync(path.join(projectRoot, ".omp-test-"));
  const stubPath = path.join(outdir, "vscode.mjs");
  writeFileSync(stubPath, STUB_SOURCE);

  const bundlePath = path.join(outdir, "extension.mjs");
  try {
    await esbuild.build({
      entryPoints: [path.join(projectRoot, "src/extension.ts")],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node20",
      outfile: bundlePath,
      external: ["@lydell/node-pty"],
      plugins: [
        {
          name: "fake-vscode",
          setup(build) {
            build.onResolve({ filter: /^vscode$/ }, () => ({
              path: "./vscode.mjs",
              external: true,
            }));
          },
        },
      ],
    });

    const fake = await importRuntimeModule<FakeVscode>(stubPath);
    const extension = await importRuntimeModule<{ activate(context: unknown): void }>(bundlePath);
    extension.activate({ subscriptions: [], extensionUri: { fsPath: projectRoot } });
    return { fake, activate: extension.activate };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

/**
 * Drains microtasks until `settled` holds. The provider only awaits promises the
 * stub already resolved, so this is deterministic — no wall-clock waits.
 */
async function drainUntil(settled: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 100 && !settled(); i++) {
    await Promise.resolve();
  }
  assert.ok(settled(), `did not settle: ${label}`);
}

function makeEditor(selection: {
  isEmpty: boolean;
  start: { line: number; character: number };
  end: { line: number; character: number };
}) {
  return {
    selection,
    document: { uri: { fsPath: "/tmp/a.ts" }, lineCount: 20 },
  };
}

/** Resolves the webview view so the provider starts receiving its messages. */
function openWebview(provider: FakeProvider, visible: boolean) {
  const posted: unknown[] = [];
  let receive: ((raw: unknown) => unknown) | undefined;

  provider.resolveWebviewView(
    {
      visible,
      webview: {
        html: "",
        postMessage(message: unknown) {
          posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage(handler: (raw: unknown) => unknown) {
          receive = handler;
          return { dispose() {} };
        },
      },
      onDidChangeVisibility() {
        return { dispose() {} };
      },
      onDidDispose() {
        return { dispose() {} };
      },
    },
    {},
    {},
  );

  return {
    posted,
    async emit(message: unknown) {
      receive?.(message);
    },
  };
}

describe("ohMyPi.sendSelectedLinesOrToggle", () => {
  it("reveals the sidebar when the view has never been resolved", async () => {
    const { fake } = await loadExtension();
    const handler = fake.registered.get("ohMyPi.sendSelectedLinesOrToggle");
    assert.ok(handler, "Control+L command must be registered");

    // Fresh window after a reload: no editor selection, webview not yet created.
    fake.window.activeTextEditor = makeEditor({
      isEmpty: true,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });

    await handler();

    assert.deepEqual(fake.executed, ["ohMyPi.terminal.focus"]);
  });

  it("closes the primary side bar by default", async () => {
    const { fake } = await loadExtension();
    const handler = fake.registered.get("ohMyPi.sendSelectedLinesOrToggle");
    assert.ok(handler);

    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    const webview = openWebview(provider, true);

    fake.window.activeTextEditor = makeEditor({
      isEmpty: true,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });

    await handler();

    assert.deepEqual(fake.executed, ["workbench.action.closeSidebar"]);
    // Toggling must never start omp before the webview reports itself ready.
    assert.deepEqual(webview.posted, []);

    provider.dispose();
  });

  it("closes the region named by ohMyPi.panelLocation", async () => {
    const { fake } = await loadExtension();
    const handler = fake.registered.get("ohMyPi.sendSelectedLinesOrToggle");
    assert.ok(handler);

    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    openWebview(provider, true);
    fake.window.activeTextEditor = makeEditor({
      isEmpty: true,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });

    fake.settings["ohMyPi.panelLocation"] = "secondary";
    await handler();
    assert.deepEqual(fake.executed, ["workbench.action.closeAuxiliaryBar"]);

    fake.executed.length = 0;
    fake.settings["ohMyPi.panelLocation"] = "panel";
    await handler();
    assert.deepEqual(fake.executed, ["workbench.action.closePanel"]);

    provider.dispose();
  });

  it("falls back to the primary side bar for an unknown panelLocation", async () => {
    const { fake } = await loadExtension();
    const handler = fake.registered.get("ohMyPi.sendSelectedLinesOrToggle");
    assert.ok(handler);

    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    openWebview(provider, true);
    fake.window.activeTextEditor = makeEditor({
      isEmpty: true,
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    });

    fake.settings["ohMyPi.panelLocation"] = "left-ish";
    await handler();

    assert.deepEqual(fake.executed, ["workbench.action.closeSidebar"]);

    provider.dispose();
  });

  it("sends a line reference instead of toggling when text is selected", async () => {
    const { fake } = await loadExtension();
    const handler = fake.registered.get("ohMyPi.sendSelectedLinesOrToggle");
    assert.ok(handler);

    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    const sent: string[] = [];
    provider.send = (data) => sent.push(data);

    fake.window.activeTextEditor = makeEditor({
      isEmpty: false,
      start: { line: 4, character: 0 },
      end: { line: 9, character: 0 },
    });

    await handler();

    assert.deepEqual(sent, ["/tmp/a.ts:5-9\n"]);
    assert.deepEqual(fake.executed, []);
  });
});

describe("Ctrl+L inside the terminal", () => {
  it("closes the configured region while the webview owns focus", async () => {
    const { fake } = await loadExtension();
    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    const webview = openWebview(provider, true);
    fake.settings["ohMyPi.panelLocation"] = "secondary";

    await webview.emit({ type: "toggleSidebar" });
    await drainUntil(() => fake.executed.length > 0, "toggle command");

    assert.deepEqual(fake.executed, ["workbench.action.closeAuxiliaryBar"]);
    provider.dispose();
  });

  it("reveals the panel when the resolved view is hidden", async () => {
    const { fake } = await loadExtension();
    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    const webview = openWebview(provider, false);

    await webview.emit({ type: "toggleSidebar" });
    await drainUntil(() => fake.executed.length > 0, "reveal command");

    assert.deepEqual(fake.executed, ["ohMyPi.terminal.focus"]);
    provider.dispose();
  });

  it("ignores unknown webview messages", async () => {
    const { fake } = await loadExtension();
    const provider = fake.providers.get("ohMyPi.terminal");
    assert.ok(provider);
    const webview = openWebview(provider, true);

    await webview.emit({ type: "nope" });
    await drainUntil(() => true, "no command");

    assert.deepEqual(fake.executed, []);
    provider.dispose();
  });
});
