# Clawd GIFs for Discord Rich Presence

Animated art for Burnglass's Discord Rich Presence, one GIF per live Claude Code
state. Discord only animates a large image that is an `https://` link (uploaded
Art Assets are stills). **Since v2.0.1 these are the built-in defaults:** an empty
Claude slot links to the `-512.gif` files here through
`https://raw.githubusercontent.com/ReFxFrank/Burnglass/v2.0.0/.github/assets/discord/`,
pinned to the `v2.0.0` tag so the links never change. To use your own copies, host them
anywhere public and paste each link into the matching slot: **System → Discord images**
in the dashboard, or the config key in `~/.burnglass/config.json`.

> Maintainers: the built-in links point at the **v2.0.0 tag**, never at `main`, so
> moving or re-rendering files here can't break anyone's presence. Never delete or move
> the `v2.0.0` tag. A new art set ships under a new pinned base in `server.js`
> (`DISCORD_DEFAULT_ART_BASE`).

| State | README size (160 px) | Full size (512 px) | Dashboard slot | Config key |
|---|---|---|---|---|
| working | `working.gif` | `working-512.gif` | Claude — working | `discordClaudeWorkingImage` |
| thinking | `thinking.gif` | `thinking-512.gif` | Claude — thinking | `discordClaudeThinkingImage` |
| waiting on you | `waiting.gif` | `waiting-512.gif` | Claude — waiting on you | `discordClaudeWaitingImage` |
| idle | `idle.gif` | `idle-512.gif` | Claude Code | `discordClaudeImage` |

`discordClaudeImage` is also the fallback for any state slot left empty. Use the
512 px files for Discord; the 160 px copies are the ones shown in the README.

All eight are transparent, loop forever and are sampled at 25 fps. Each file is
exactly one loop: working 1 s, thinking 12 s, waiting 4 s, idle 18 s. The pixel art is
drawn at the same scale in every state (5 px per art pixel at 160 px, 16 px at
512 px). Transparency is 1-bit, so the soft ground shadows in the source SVGs
are left out.

`clawd-pixel.gif` (512 px) is a separate, hand-drawn pixel Clawd made for
Burnglass: it blinks, shuffles its legs and throws both claws up (3.6 s loop).

## Source and licence

The four state GIFs are rendered from the animated SVGs in
[marciogranzotto/clawd-tank](https://github.com/marciogranzotto/clawd-tank)
at commit `a8942d140eeb8bcf549857ad599f7d62fd29eb01`, which is MIT-licensed. The
full licence text is in [`LICENSE-clawd-tank.txt`](LICENSE-clawd-tank.txt).

| GIF | clawd-tank SVG |
|---|---|
| working | `clawd-working-building.svg` |
| thinking | `clawd-working-typing.svg` |
| waiting | `clawd-notification.svg` |
| idle | `clawd-sleeping.svg` |

Clawd is Anthropic's character. All the GIFs in this folder, `clawd-pixel.gif`
included, are unofficial fan art and are not affiliated with or endorsed by
Anthropic.
