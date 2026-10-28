/**
 * Test the footer segment against the real FooterComponent.
 *
 * The test copies the extension into test/.tmp and links the Pi packages beside
 * it, so the extension resolves @earendil-works/* the same way Pi does. Run it
 * with `npm test`. Set PI_MODULES if your Pi install is not under `npm root -g`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);
const extension = path.join(repo, "extensions", "tok-per-sec.ts");

function modulesDir() {
  const home = process.env.HOME ?? "";
  const candidates = [process.env.PI_MODULES];
  try {
    candidates.push(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim());
  } catch {
    // npm is not on PATH; other candidates may still work.
  }
  candidates.push(path.join(home, ".bun/install/global/node_modules"));
  for (const dir of candidates) {
    if (!dir) continue;
    const root = path.join(dir, "@earendil-works");
    if (fs.existsSync(path.join(root, "pi-coding-agent")) && fs.existsSync(path.join(root, "pi-tui"))) {
      return dir;
    }
  }
  throw new Error(
    `Cannot find a Pi installation. Set PI_MODULES to the directory that contains @earendil-works/. Tried: ${candidates.filter(Boolean).join(", ")}`,
  );
}

const mods = modulesDir();
const tmp = path.join(here, ".tmp");
fs.rmSync(tmp, { recursive: true, force: true });
const nodeModules = path.join(tmp, "node_modules", "@earendil-works");
for (const pkg of ["pi-coding-agent", "pi-tui", "pi-ai", "pi-agent-core"]) {
  const src = path.join(mods, "@earendil-works", pkg);
  if (!fs.existsSync(src)) continue;
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.symlinkSync(src, path.join(nodeModules, pkg), "dir");
}
const extCopy = path.join(tmp, "tok-per-sec.ts");
fs.copyFileSync(extension, extCopy);

const { initTheme, theme } = await import(
  path.join(mods, "@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js")
);
const { visibleWidth } = await import(path.join(mods, "@earendil-works/pi-tui/dist/index.js"));
const { default: registerExtension } = await import(pathToFileURL(extCopy).href);

initTheme("dark");

const usage = {
  input: 1234,
  output: 456,
  cacheRead: 120000,
  cacheWrite: 3400,
  totalTokens: 0,
  cost: { total: 0.1234 },
};
const model = { id: "claude-sonnet-4-5", contextWindow: 200000, reasoning: true, provider: "anthropic" };
const entries = [
  { type: "message", message: { role: "user", content: "hi" } },
  { type: "message", message: { role: "assistant", content: [], usage } },
];
const footerData = {
  getGitBranch: () => "main",
  getAvailableProviderCount: () => 2,
  getExtensionStatuses: () => new Map([["herdr", "pane 3"]]),
  onBranchChange: () => () => {},
};

const ctx = {
  mode: "tui",
  hasUI: true,
  cwd: "/Users/dev/some/pretty/long/project/path",
  model,
  thinkingLevel: "medium",
  sessionManager: {
    getEntryCount: () => entries.length,
    getSessionId: () => "s1",
    getLeafId: () => "l1",
    getEntries: () => entries,
    getCwd: () => ctx.cwd,
    getSessionName: () => "demo",
  },
  getContextUsage: () => ({ tokens: 45000, contextWindow: 200000, percent: 22.5 }),
  ui: { footer: undefined, setFooter(f) { this.footer = f; }, notify() {}, theme },
};

const handlers = {};
const commands = {};
registerExtension({
  on(event, handler) {
    (handlers[event] ??= []).push(handler);
  },
  registerCommand(name, def) {
    commands[name] = def;
  },
});

const emit = async (type, payload) => {
  for (const handler of handlers[type] ?? []) await handler({ type, ...payload }, ctx);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const failures = [];
function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition || !detail ? "" : `\n      ${detail}`}`);
  if (!condition) failures.push(name);
}

function footer() {
  return ctx.ui.footer(ctx.ui, theme, footerData);
}

await emit("session_start", {});
check("no segment before the first response", !plain(footer().render(110)[1]).includes("tok/s"));

// A response that reports usage while it streams.
await emit("message_start", { message: { role: "assistant" } });
for (let i = 0; i < 6; i++) {
  await wait(50);
  await emit("message_update", {
    message: { role: "assistant" },
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "hello world token ".repeat(6),
      partial: { usage: { output: (i + 1) * 120 } },
    },
  });
}
const streaming = plain(footer().render(110)[1]);
check("segment appears while the model streams", streaming.includes("tok/s"), streaming);
check("segment sits in the stats row, before the model name", streaming.indexOf("tok/s") < streaming.indexOf("claude-sonnet"), streaming);

await emit("message_end", { message: { role: "assistant", usage: { ...usage, output: 300 } } });
check("segment stays after the response finishes", plain(footer().render(110)[1]).includes("tok/s"));

// A provider that reports usage only at the end: the estimate must work.
await emit("message_start", { message: { role: "assistant" } });
for (let i = 0; i < 5; i++) {
  await wait(60);
  await emit("message_update", {
    message: { role: "assistant" },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "x".repeat(80), partial: {} },
  });
}
check("segment uses the chars/4 estimate", plain(footer().render(110)[1]).includes("tok/s"));
await emit("message_end", { message: { role: "assistant", usage: { ...usage, output: 4000 } } });

// Width sweep: the row must never be wider than the request.
let overflow = "";
for (const cwd of ["/tmp/x", "/".padEnd(60, "/verylongdirectoryname")]) {
  ctx.cwd = cwd;
  await emit("message_start", { message: { role: "assistant" } });
  for (let i = 0; i < 4; i++) {
    await wait(80);
    await emit("message_update", {
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "y".repeat(200), partial: { usage: { output: (i + 1) * 250000 } } },
    });
  }
  await emit("message_end", { message: { role: "assistant", usage: { ...usage, output: 999999 } } });
  for (let width = 30; width <= 200; width++) {
    for (const line of footer().render(width)) {
      if (visibleWidth(line) > width) overflow += `\n      cwd=${cwd} width=${width} visible=${visibleWidth(line)} :: ${plain(line)}`;
    }
  }
}
check("no row is wider than the requested width (30..200)", overflow === "", overflow);

check("segment still shows at 100 columns", plain(footer().render(100)[1]).includes("tok/s"));

// Model and thinking level follow the session events.
await emit("model_select", { model: { ...model, id: "gpt-5-mini" }, previousModel: model, source: "command" });
await emit("thinking_level_select", { level: "high", previousLevel: "medium" });
const switched = plain(footer().render(120)[1]);
check("model_select and thinking_level_select update the row", switched.includes("gpt-5-mini") && switched.includes("high"), switched);

// The command restores the built-in footer.
await commands.toks.handler("", ctx);
check("/toks hides the segment", ctx.ui.footer === undefined);
await commands.toks.handler("", ctx);
check("/toks shows the segment again", typeof ctx.ui.footer === "function");

console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll checks passed.");
process.exitCode = failures.length ? 1 : 0;
