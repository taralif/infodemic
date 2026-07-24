# INFODEMIC

*A cooperative game where you and your friends investigate real news across simulated social platforms — using real journalism to fight back against the noise.*

Built by [Tara Lifland](mailto:taralifland@gmail.com) through the [Assembly Code](https://assemblycode.org) fellowship, summer 2026. Fiscally sponsored by the Edward Charles Foundation.

## What this is

Your feed is sixteen stories deep today. Some are true, some are bait, one isn't settled yet. Players secretly gut-check every claim, discover where the table *disagrees*, then investigate the contested ones using the three questions from Stanford's [Civic Online Reasoning](https://cor.inquirygroup.org): **Who's behind this information? What's the evidence? What do other sources say?** Claims settle only when evidence persuades the table — there are no answer keys in play. Turning a claim green requires filing a signed Case Report. The team wins by tipping the balance: making accurate information more prevalent than false. Misinformation is never "solved" — that's the point.

**Current status:** paper prototype (playtests running now, with middle/high schoolers as co-designers). Digital build begins soon — its scope is one sentence: *the digital version exists because paper can't mimic the algorithm in how misinformation spreads.*

## Repository layout

| Folder | Contents |
|---|---|
| `cases/` | Feed Drops — the game's content: real claims, paraphrased, cited, human-vetted. **Licensed CC BY-SA 4.0** (see `cases/LICENSE`) |
| `docs/` | The [Curation Charter](docs/curation-charter.md) — how stories are chosen, and how to challenge us |
| `playtest/` | Print-and-play kit, playtest/co-design protocol, card art prompts |
| `board/` | 24×36 printable game board + the script that generates it |
| `prototype/` | Early visual spikes (disposable, kept for the record) |

## The feed shows its work

Every claim card traces to public sources listed in its case file, with a completed vetting checklist and a changelog. Think we got a card wrong? Open an issue titled **"Case report against the editor"** and bring evidence — sustained challenges produce published corrections. See the [Curation Charter](docs/curation-charter.md).

*Facilitators: case files include the fact-checkers' record for debrief use. Players — no peeking before the game; you'd only be spoiling yourselves out of the fun part.*

## Licensing

- **Code** (everything outside `cases/`): [GNU AGPL-3.0](LICENSE)
- **Case content** (`cases/`): [CC BY-SA 4.0](cases/LICENSE)
- Case #1 adapts the subject of a Stanford Civic Online Reasoning assessment from independent public sources; COR is credited as inspiration. COR's own materials carry their own licenses.

## Thanks

Playtesters and teen co-designers credited here (first names, with permission) as sessions happen.
