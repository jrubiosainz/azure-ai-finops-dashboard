# DESIGN.md

Visual world of record for **Tablón de cotizaciones · Gasto en IA**.
Schema 1 · Surface: `web` · Mode: **Operate** · Language: Spanish (es-ES).

---

## Thesis

An exchange quotation board for Azure AI spend. Money is quoted, not visualised; the
board states figures with the finality of a market close, and every figure carries the
provenance of how it was obtained. The surface exists to survive a hostile question from
a FinOps reviewer, so its authority comes from citation, not from decoration.

## Own-world

**Fused staging: exchange board + pipe-organ keydesk.**

The board face is the graphite quotation panel: figures set in flap cells behind brass
tabs, seams between cells, a brass channel along the bottom lip of the casing. Below it
the paper stock takes over — grey quotation stock with faint horizontal ruling, the way a
printed floor sheet looks.

The keydesk is the filter model. Filters are not "controls that update a chart"; they are
**registration stops** pulled *before* the board quotes. The rail sits directly beneath
the tape and is labelled `REGISTROS · Deciden qué puede cotizar el tablón antes de leerlo`.
Pulling a stop re-quotes the entire board and every ledger against the same slice, so the
headline figures and the rows can never disagree.

**Deliberately not:** the dark-navy SaaS dashboard with gradient KPI tiles, and its
equally exhausted opposite, the minimal white Linear-style analytics page. Neither was
allowed to influence a single decision.

## Story

1. **The board quotes the close.** Six figures, full-bleed graphite: total spend, AI
   spend, token spend, calls, cost per call, cost per 1k tokens. The split between *AI
   spend* and *token spend* is the first honest thing the page says — most AI money in
   a deployment can include services beyond token inference.
2. **The tape shows when.** One continuous daily strip, spend stacked with AI spend and
   the call count drawn over it, with real axis dates and a crosshair readout.
3. **The stops narrow the floor.** Resource group, resource, model, provenance.
4. **The ledgers itemise.** Ruled tables for deployments, agents and billing meters.
   The last one carries Azure's literal meter names, grouped by resource.
5. **The register groups by use case.** The one thing the invoice cannot say: which
   business use case a deployment and an agent belong to, read from the gateway's own
   tags, with the input/output split and the agent census of each case.
6. **The notice states the limits.** What Azure cannot answer, in plain Spanish, before
   anyone can be misled by an absence.

## First viewport

Graphite board edge to edge. Title in uppercase system sans-serif, subscription and date range in
mono directly beneath. Brass `RELEER AZURE` piston top-right with the last-read stamp
beside it. Under that, six quote cells behind brass tabs, separated by seams, each with a
one-line note in its own words explaining what the figure is and is not. The brass channel
closes the casing, and the tape begins immediately below — no hero, no gap, no scroll
before the first real number.

## Form

**Palette** — chosen to escape the AI-default cream-and-terracotta cluster entirely.

| Token | Value | Role |
|---|---|---|
| `--paper` | `#dedbd4` | quotation stock |
| `--board` | `#14181c` | board face |
| `--board-sunk` | `#0e1216` | tape well |
| `--flap` | `#eceae4` | figures on the board |
| `--debit` | `#c2381f` | exchange red — cost |
| `--credit` | `#1e6f5c` | exchange green — output rates |
| `--brass` | `#b0842e` | tabs, piston, board lip |
| `--ink` | `#1a1d21` | body text on stock |

Red is *only* money out. Green is *only* the output-side rate. Brass is *only* mechanism
(tabs, the piston, the casing lip). No colour is used decoratively anywhere.

**Type** — system sans-serif for lettering and system monospace for figures, meter
names and identifiers. No font service or CDN is contacted by the interface.

**Motion** — the split-flap. Figures flip character by character with a 34 ms stagger when
their value changes, so a refresh or a change of cut is *legible as movement* rather than
a silent substitution. The cascade is the second motion system: drilling re-flows the
proportional bands through `grid-template-columns` over 420 ms, and the rails below settle
in sequence at 55 ms apart, so a drill reads as a cut travelling down the estate rather
than four bands blinking at once. The tape crosshair and the row hover are instantaneous.
All of it is disabled under `prefers-reduced-motion`.

**Density** — deliberately high. This is a document to be read across, not a set of
summary cards. Sub-lines under every primary cell carry region, account, SKU, deployment
count and agent id, because the reviewer's next question is always "which one".

## The cascade

The drill-down *is* the chart. Four stacked rails — resource group → resource → deployment →
meter on the estate axis, account → project → agent → model on the Foundry axis, use
case → agent → deployment → model on the use-case axis — each a single horizontal band
divided into proportional segments. Clicking a segment selects related rails and ledgers.
Daily trend, call evidence and the lower use-case register stay global and say so.
The band a level's segments live in is
therefore both the visualisation and the control: there is no separate filter widget whose
state you have to reconcile with a separate chart.

Rules the cascade keeps: segments below 5.5 % of the band lose their label rather than
clipping it; the tail beyond fourteen segments pools into one hatched `resto` block so the
band never degenerates into a comb; the selected segment goes brass; a rail with nothing
under it says so in words instead of rendering an empty bar.

## Rules this world keeps

- **No cards.** Ruled tables and one board face. Nothing floats in a rounded container.
- **No KPI tile grid.** The six quotes are cells of one continuous board with seams and
  brass tabs, not six separate widgets.
- **No kicker/eyebrow, no gradient text, no glass, no blur.**
- **The sparkline is real content.** The tape has its own scale, its own dates, a legend
  and a readout. It is not a decorative squiggle.
- **Secondary text on the board is tinted from the hue**, never neutral grey.
- **Every attributed figure carries a provenance mark.** `Facturado`, `Medido`,
  `Derivado`, `Estimado`. A number without a mark is a number the board refuses to claim.
- **Absences are stated, and their shape is stated too.** The `notice` block and the
  coverage assay distinguish *not instrumented* from *not possible*. Telemetry reaching
  a small share of measured requests is reported as a qualified coverage indicator,
  never as a reconciled percentage of the invoice.

## Provenance taxonomy

| Mark | Meaning |
|---|---|
| `Facturado` | Straight from Cost Management. |
| `Medido` | Straight from Azure Monitor. |
| `Derivado` | Billed cost ÷ metered tokens — the effective rate actually paid. |
| `Estimado` | An inferred allocation. Azure does not expose this attribution. |

This taxonomy is the design. It is what lets the board be used in an argument.

## Responsive

Breakpoints at 1180 / 860 / 620 px. The quote grid steps 6 → 3 → 2. The console stacks its
labels above its knobs. Cascade rails drop their name and total columns and stack, keeping
the band full width, because the band is the information. The call tape sheds its operation
column at 1180 and its timestamp and latency at 620, in that order, because *who and how
much* survives a phone and *when* does not. Ledgers scroll horizontally inside their own
well rather than shrinking columns to illegibility — a currency column that has to be
scrolled to is still readable; one that has been squeezed is not.
