# pi-speedometer

pi-speedometer shows how fast the model writes tokens.

It adds one segment to the Pi footer stats row:

```
~/dev/app (main) • demo
↑1.2k ↓456 R120k W3.4k CH96.3% $0.123 22.5%/200k (auto) ⚡434 tok/s     (anthropic) claude-sonnet-4-5 • medium
```

The segment sits in the same row as the input, output, cache, cost, and context
numbers. The accent colour means the model streams now. The dim colour shows the
rate of the last finished response while Pi is idle.

## Install

Install from GitHub:

```bash
pi install git:github.com/shantanugoel/pi-speedometer
```

Try it for one run only:

```bash
pi -e git:github.com/shantanugoel/pi-speedometer
```

Or copy the single file into your extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/shantanugoel/pi-speedometer/main/extensions/tok-per-sec.ts \
  -o ~/.pi/agent/extensions/tok-per-sec.ts
```

Then run `/reload` in Pi, or start a new session.

## Use

- The rate appears when a response is long enough to measure (at least 0.2 s of
  streaming).
- Run `/toks` to hide or show the segment. When you hide it, Pi renders the
  built-in footer unchanged.
- Run `/reload` after you edit the file.

## What the number means

```
rate = output tokens / seconds since the first stream delta
```

- Output tokens include thinking tokens, as the provider reports them.
- During streaming, most providers report no usage yet. The extension then uses
  a `characters / 4` estimate. The final number uses the real usage value.
- The extension writes the rate with the same `k` and `M` suffixes as the
  built-in token counts, so a very fast rate stays narrow.
- The rate covers one assistant message. A tool call between two messages does
  not add time to either rate.

## How it works

Pi only lets an extension replace the whole footer with `ctx.ui.setFooter()`.
`ctx.ui.setStatus()` writes on a separate line, so it cannot put text in the
stats row.

The extension therefore renders the real `FooterComponent` from
`@earendil-works/pi-coding-agent` and puts the segment in the space between the
stats parts and the right-aligned model name. The stats parts use one space
between them, so the first run of two or more spaces is that space, and it is
the only safe insert point. If the row has no room, the extension renders the
built-in footer a few columns narrower — it gives up padding first, then it
shortens the model name — and fills the room it gives up. If there is still no
room, the extension drops the segment instead of wrapping the row. All insert
code runs inside a `try`/`catch`, so the footer cannot break.

## Limits

- The number is per session and per assistant message. Subagents run in their
  own `pi` processes and their own session files, so their tokens are not
  counted. The parent footer stats row does not count them either.
- The built-in `(sub)` subscription marker and the `→ routed-model` suffix do
  not appear. The built-in footer reads `modelRuntime` and `routedModel`, and
  the extension context does not expose them.
- The `(auto)` compact marker always appears, because the extension context does
  not expose the auto-compact setting.
- A very narrow terminal (below roughly 85 columns with a long model name) has
  no room for the segment. The footer then stays exactly as the built-in footer
  renders it.

## Test

The test drives the real `FooterComponent` and checks the rendered width:

```bash
npm test
```

It resolves the Pi installation from `npm root -g`. Set `PI_MODULES` to the
directory that contains `@earendil-works/` if your install lives elsewhere.

The test checks these conditions:

- the row never becomes wider than the requested width, for widths 30 to 200;
- the segment appears during streaming and after it;
- the segment is absent when no response has streamed;
- `/toks` removes and restores the custom footer.

## License

MIT
