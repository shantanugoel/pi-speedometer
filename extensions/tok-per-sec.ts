/**
 * pi-speedometer - tok/s in the Pi footer stats row.
 * https://github.com/shantanugoel/pi-speedometer
 *
 * The extension adds the assistant output rate to the built-in footer row that
 * already shows ↑input ↓output RcacheRead WcacheWrite CHcache-hit $cost and
 * context %.
 *
 * How it works: Pi only allows a full footer replacement (ctx.ui.setFooter).
 * So this extension renders the real FooterComponent and puts one segment in
 * the space between the stats parts and the right-aligned model name. All
 * other parts (pwd, git branch, session name, context colour, model, thinking
 * level, extension statuses) come from the built-in footer unchanged.
 *
 * Rate rules:
 * - rate = output tokens / seconds since the first stream delta.
 * - output tokens include thinking tokens, as the provider reports them.
 * - During streaming the rate uses a chars/4 estimate, because most providers
 *   report usage only at the end of a response.
 * - The rate stays visible after the response finishes (dim, not accent).
 *
 * Limits from the extension context: the "(sub)" subscription marker and the
 * routed virtual-model target are not shown, because FooterComponent reads
 * modelRuntime and routedModel and the extension context does not expose them.
 *
 * Toggle with /toks
 */

import {
  FooterComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

type Model = NonNullable<ExtensionContext["model"]>;
type Thinking = NonNullable<ExtensionContext["thinkingLevel"]>;
type Theme = { fg: (color: string, text: string) => string };
type Rate = {
  tokens: number;
  chars: number;
  startedAt: number;
  firstDeltaAt?: number;
  endedAt?: number;
};

const SUB_RUNTIME = { isUsingSubscription: () => false };

let enabled = true;
let model: Model | undefined;
let thinking: Thinking | undefined;
let live: Rate | undefined; // assistant message that streams right now
let last: Rate | undefined; // last finished assistant message

function tokens(r: Rate): number {
  return r.tokens > 0 ? r.tokens : Math.round(r.chars / 4);
}

function rateOf(r: Rate): number | undefined {
  const from = r.firstDeltaAt ?? r.startedAt;
  const to = r.endedAt ?? performance.now();
  const seconds = (to - from) / 1000;
  const n = tokens(r);
  if (n <= 0 || seconds < 0.2) return undefined;
  return n / seconds;
}

function formatRate(rate: number): string {
  // Same shape as the built-in token formatter, so a big rate stays narrow.
  if (rate < 10) return rate.toFixed(1);
  if (rate < 1000) return String(Math.round(rate));
  if (rate < 10000) return `${(rate / 1000).toFixed(1)}k`;
  if (rate < 1000000) return `${Math.round(rate / 1000)}k`;
  return `${(rate / 1000000).toFixed(1)}M`;
}

function rateSegment(theme: Theme): string {
  const r = live ?? last;
  if (!r) return "";
  const rate = rateOf(r);
  if (rate === undefined) return "";
  return theme.fg(live ? "accent" : "dim", `⚡${formatRate(rate)} tok/s`);
}

/** Built-in footer plus one segment in the gap before the model name. */
class TokFooter {
  private inner: FooterComponent;
  private theme: Theme;

  constructor(theme: Theme, footerData: ReadonlyFooterDataProvider, ctx: ExtensionContext) {
    this.theme = theme;
    const session = {
      get sessionManager() {
        return ctx.sessionManager;
      },
      get model() {
        return model;
      },
      get routedModel() {
        return undefined;
      },
      get state() {
        return { model, thinkingLevel: thinking };
      },
      get modelRuntime() {
        return SUB_RUNTIME;
      },
      getContextUsage: () => ctx.getContextUsage(),
    };
    this.inner = new FooterComponent(session as never, footerData);
  }

  /**
   * The built-in row is "<stats><padding><model>". The stats parts use one
   * space between them, so the first run of two or more spaces is that
   * padding. That space is the only safe insert point. When the row has no
   * room at `width`, the extension asks for a row that is `reserve` columns
   * narrower. The built-in footer gives up padding first, then shortens the
   * model name. The segment fills the room it gives up.
   */
  private insertSegment(seg: string, width: number, reserve: number): string[] | undefined {
    const lines = this.inner.render(width - reserve);
    const line = lines[1];
    const gap = line ? / {2,}/.exec(line) : null;
    if (!gap) return undefined;
    const need = 1 + visibleWidth(seg);
    const keep = reserve === 0 ? gap[0].length - need : gap[0].length;
    if (keep < 2) return undefined;
    lines[1] =
      line.slice(0, gap.index) + " " + seg + " ".repeat(keep) + line.slice(gap.index + gap[0].length);
    return lines;
  }

  render(width: number): string[] {
    try {
      const seg = rateSegment(this.theme);
      if (seg) {
        const need = 1 + visibleWidth(seg);
        return this.insertSegment(seg, width, 0) ?? this.insertSegment(seg, width, need) ?? this.inner.render(width);
      }
    } catch {
      // Never break the footer for a display extra.
    }
    return this.inner.render(width);
  }

  invalidate(): void {
    this.inner.invalidate();
  }

  dispose(): void {
    this.inner.dispose();
  }
}

export default function (pi: ExtensionAPI) {
  function apply(ctx: ExtensionContext): void {
    if (!enabled || ctx.mode !== "tui") return;
    ctx.ui.setFooter((_tui, theme, footerData) => new TokFooter(theme as Theme, footerData, ctx));
  }

  pi.registerCommand("toks", {
    description: "Toggle tok/s in the footer stats row",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
      if (enabled) apply(ctx);
      ctx.ui.notify(enabled ? "tok/s shown" : "tok/s hidden", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    model = ctx.model;
    thinking = ctx.thinkingLevel;
    live = undefined;
    last = undefined;
    apply(ctx);
  });

  pi.on("model_select", async (event) => {
    model = event.model;
  });

  pi.on("thinking_level_select", async (event) => {
    thinking = event.level;
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    live = { tokens: 0, chars: 0, startedAt: performance.now() };
  });

  pi.on("message_update", async (event) => {
    if (!live) return;
    const streamEvent = event.assistantMessageEvent;
    if (streamEvent.type === "text_delta" || streamEvent.type === "thinking_delta" || streamEvent.type === "toolcall_delta") {
      if (live.firstDeltaAt === undefined) live.firstDeltaAt = performance.now();
      live.chars += streamEvent.delta.length;
      const usage = (streamEvent.partial as { usage?: { output?: number } }).usage;
      if (usage && typeof usage.output === "number" && usage.output > 0) live.tokens = usage.output;
    }
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant" || !live) return;
    const usage = (event.message as { usage?: { output?: number } }).usage;
    if (usage && typeof usage.output === "number" && usage.output > 0) live.tokens = usage.output;
    live.endedAt = performance.now();
    last = live;
    live = undefined;
  });
}
