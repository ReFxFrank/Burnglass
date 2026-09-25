# Custom sources

Bring your own agent: have it write one JSON line per request, and Burnglass tracks it like any built-in source.

[← Back to the README](../README.md) · [All docs](README.md)

---

If you run your **own** model or agent (a local fine-tune, a homemade harness, an
internal tool), have it append one JSON line per completed request to a JSONL file and
declare the file in `~/.burnglass/config.json`.

## Declare the source

```json
{
  "customSources": [
    { "name": "foreman", "label": "FOREMAN", "path": "/home/you/.foreman/usage.jsonl" }
  ]
}
```

On Windows, escape backslashes in the path: `"C:\\Users\\you\\.foreman\\usage.jsonl"`.

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | The source's permanent identity (see below). |
| `path` | yes | A file, or a directory of `*.jsonl` files. |
| `label` | no | The name shown in the dashboard. Defaults to `name`. |

### `name`

A short lowercase slug of up to 24 characters: a letter first, then `a-z`, `0-9`, `_` or
`-`. It's the source key in filters, colours and CSV columns, **and the identity your
history is archived under, so treat it as permanent**. Change the visible text with
`label` instead.

- Built-in names are reserved: `cli`, `claude`, `codex`, `gemini`, `cline`, `continue`,
  `roo` and `mixed`.
- You can have up to 8 custom sources.
- An invalid row (bad or reserved name, a duplicate, a missing path) is dropped, with a
  one-time warning in the server log saying why.
- If you rename a `name`, Burnglass detects it and retires the old identity from days it
  still has logs for, so nothing counts twice. Days that exist only in the archive keep
  the old name.

### `path`

- A **file** of any extension, or a **directory**: Burnglass reads every `*.jsonl` under a
  directory, so monthly rotation just works.
- Use an absolute path; it's used exactly as written (no `~` expansion).
- A path that doesn't exist yet means no usage yet, not an error.
- A file another source already reads (for example, anything inside `~/.claude`) is
  refused, with a warning, so nothing is counted twice.
- Files over **50 MB** are skipped with a warning. Rotate into a directory of smaller files.

### `label`

An optional display name (for example `FOREMAN`), shown everywhere the source appears:
the rail, the chart legend and tooltip, By source, sessions, the mini view and Burnglass
Strip's donut. Up to 24 characters. A label equal to a built-in source name (`claude`,
`codex`, `gemini` and so on, in any case), or to another source's name or label, falls
back to the name.

## Record schema

One JSON object per line. Unknown keys are ignored.

```json
{"ts":"2026-08-14T21:03:07.412Z","id":"<uuid per request>","model":"foreman-7b","input":1234,"output":567,"cached":0,"sessionId":"run-42","project":"my-game-server","estimate":false}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ts` | yes | When the request finished: ISO-8601, epoch milliseconds, or epoch seconds. |
| `input` | * | Input tokens, **including** any cached part. |
| `output` | * | Output tokens. |
| `cached` | no | The part of `input` served from a prompt cache. |
| `id` | recommended | A stable per-request id. Burnglass dedups on it with **last-write-wins**, so replays and rewrites never double-count, even across rotated files. Without an id, a line is identified by its file and position. |
| `model` | no | Shown in **By model**. Defaults to the source name. |
| `sessionId` | no | Groups requests into sessions. Defaults to the source name. |
| `project` | no | Shown in **By project** and the sessions table. |
| `cost` | no | A finite USD cost (0 or more). If present, Burnglass trusts it as-is, as it does Cline's. |
| `estimate` | no | `true` badges the source `est` when your counts aren't tokenizer-exact. |

\* At least one of `input` and `output` must be above zero, or the line isn't counted.

**Cost:** without a `cost`, the source is **tokens-only at $0**. A local model has no
API bill, and Burnglass won't invent one or guess a price from the model name.

## What you get

Everything is automatic: the source gets a checkbox in the rail, a stable colour, a
series in the spend chart, a By-source row, sessions rows, a CSV export column and
archive retention like every other source.

- Custom usage never touches the **5-hour block** (that's Claude Code's own limit), and
  never moves your spend totals unless your records carry real costs.
- As with every source, Burnglass only ever **reads** the log.
- Known limitation: Burnglass Strip's popover lists each custom source under its own
  label in its spend donut, but its per-provider cards and its taskbar Claude price still
  count custom sources as Claude.
