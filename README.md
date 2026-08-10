# React vs vanilla JS DOM — the virtual DOM is not a faster DOM

One question, measured:

> **When React updates the screen, where does the time go — and how much of that
> work was avoidable?**

React is compared against three hand-written DOM strategies that all produce
**byte-identical HTML**. Because the output is identical, any difference in cost
is a difference in how they got there. That is the control the whole experiment
rests on.

This is not a framework leaderboard. There is React, three reference points, and
a set of instruments pointed at React's update pipeline from the outside.

---

## Quick start

```bash
npm install
npm run verify     # ~15s — build, 22-scenario correctness gate, headless smoke run
npm run measure    # builds production React, serves on http://localhost:4173
```

Open the page and click **Run all scenarios**.

`npm run measure` builds first on purpose. `npm run dev` gives you React's
*development* build, which is several times slower because it carries extra
warnings and checks — the page shows a red banner if you end up there.

Run `npm run verify` before trusting any number in this repo. It fails on exit
status rather than on output that merely looks complete.

---

## The five strategies

| Strategy | What it receives | What it does |
| --- | --- | --- |
| `vanilla · rebuild` | the next state | Regenerates all 1,000 rows into `innerHTML` |
| `vanilla · keyed diff` | the next state | Discovers the change itself, via an id → node map |
| `vanilla · targeted` | the change, pre-addressed | Writes the one node it was told about |
| `react · key={row.id}` | the next state | Renders, reconciles, commits |
| `react · key={index}` | the next state | Same, but identity follows list position |

Three of these do different jobs, and the difference matters more than the
numbers:

- **keyed diff is the fair comparison.** It gets exactly what React gets and
  solves the same problem. The gap between it and React is React's component
  model, not "the cost of the virtual DOM" — both are reconciling.
- **targeted is the floor.** It is handed the answer, so nothing can beat it. It
  exists to turn "the theoretical minimum" into a row that actually ran.
- **rebuild is the naive baseline** — how a lot of hand-written DOM code
  genuinely works.

---

## Headline results

N = 1,000 rows, production React 19.2, medians over 100 pooled samples across
two fresh Chrome processes. **`total` = script + forced style/layout**; paint and
compositing are outside it.

### One label changed, mid-list

| Strategy | DOM ops | script | layout | total |
| --- | ---: | ---: | ---: | ---: |
| vanilla · rebuild | 2,000 | 6.20 | 19.80 | **26.90** |
| vanilla · keyed diff | 1 | 0.70 | 0.60 | 1.20 |
| vanilla · targeted | 1 | 0.00 | 0.60 | 0.60 |
| react · key={row.id} | 1 | 1.70 | 0.55 | **2.30** |

React performed **exactly one** DOM operation, which is the minimum this update
allows. It is ~12× faster than rebuilding, and slower than both careful
hand-written strategies.

Most of rebuild's cost is not JavaScript. Replacing 1,000 nodes invalidates far
more layout than writing one text node — **19.80 ms against 0.55 ms**, for
identical final HTML. The browser re-lays-out what an update *invalidated*, not
what exists at the end.

### React can do zero DOM work and still spend time

Every row object replaced, every value identical, so the correct amount of DOM
work is zero:

| Strategy | DOM ops | script |
| --- | ---: | ---: |
| vanilla · keyed diff | 0 | 0.70 ms |
| react · key={row.id} | 0 | **2.20 ms** |

React was right — it touched nothing — and spent 2.20 ms establishing that.
Components still ran, elements were still created, the comparison still walked
all 1,000 rows. A render is not a DOM update.

### Keys are a correctness feature, not a performance one

Swapping the rows at positions 1 and 998, where the minimum is 4 operations:

| Strategy | DOM ops |
| --- | ---: |
| vanilla · targeted | 4 |
| vanilla · keyed diff | 1,994 |
| react · key={row.id} | 1,994 |
| react · key={index} | **6** |

Index keys look 300× cheaper here. They are also wrong: identity belongs to the
position, so React rewrites a node's contents in place and anything the browser
held on that node — focus, selection, an uncontrolled input's value — stays
behind while the data moves on. Both lists render the same labels in the same
order, and a mutation count cannot tell them apart.

The 1,994 is not React being careless. A hand-written keyed diff, written
independently, produced exactly the same number. It is what a single-pass linear
match does.

Reverse the scenario and the table inverts: index keys cost **3,001** operations
on insert-at-head where stable keys cost **1**.

### The premium doesn't track what kind of change it is

Seven kinds of DOM change (text, attribute, class, style, conditional child in
and out, element type), each at one row and every row — 14 cells:

| Comparison | Range | Median |
| --- | --- | --- |
| react − keyed diff | +0.35 to +2.15 ms | +1.10 ms |
| react − targeted | +0.90 to +2.60 ms | +1.80 ms |

React's additional cost did not scale strongly with mutation count or category
in this workload. It is consistent with per-update render and reconciliation
work — though the harness cannot prove the cost is constant, or assign it to any
single internal mechanism.

---

## How it is measured

Two instruments, because they answer different questions.

**Counting** — a `MutationObserver` records every change to the live page. It
produces an integer, identical on every run and every machine. It answers *how
much of the work was necessary?*

**Timing** — `performance.now()` around the update, plus a forced style and
layout flush. Noisy, so it is repeated and reported as a median. It answers *did
it matter?*

They run in **separate passes**, because attaching the observer costs 0.2–0.7 ms
— up to a quarter of React's update-one-row figure.

React updates are wrapped in `flushSync()` so the work finishes inside the timer.
That is a measurement boundary, not normal application scheduling.

Full detail, including the verification gate and every trap found along the way:
**[METHODOLOGY.md](./METHODOLOGY.md)**.

---

## What this does not measure

- **Bundle size and startup.** React adds bytes, parse time and boot work before
  it renders anything. Real, but not measured here.
- **Deep or complex trees.** This is a flat list of simple rows. Real apps have
  nesting, context, and state spread across components.
- **Developer experience**, which is the actual reason people use React and is
  not something a stopwatch can answer.
- **Other frameworks.** Svelte, Vue and Solid make different trade-offs. Nothing
  here measures them.
- **Production React scheduling.** `flushSync` bypasses concurrent scheduling,
  batching and time-slicing.
- **Mobile hardware.** These are desktop results. Use `--throttle 4` rather than
  extrapolating.

---

## Reproducing the datasets

```bash
npm ci                 # exact locked dependencies (Node >= 20)
npm run standard       # results-n1000.csv        + raw samples + manifest, ~4 min
npm run matrix         # results-matrix-n1000.csv + raw samples + manifest, ~6 min
```

The runners auto-detect Chrome/Chromium; set `CHROME_BIN=/path/to/chrome` if
yours lives elsewhere. Each CSV ships with `<name>.raw.json` (raw samples grouped
by process) and `<name>.manifest.json` (command, environment, sample count,
viewport, scenario order).

For repeatable numbers or CPU throttling:

```bash
node scripts/headless.js --rows 5000 --throttle 4 --csv out.csv
```

---

## Files

```text
src/
  runner.js          the measurement loop
  measure.js         MutationObserver counting, medians, forced layout
  scenarios.js       standard scenarios and mutation matrix plans
  data.js            deterministic row generation
  main.jsx           the page: controls, result tables, charts
  KeysDemo.jsx       the correctness demo — why op counts cannot see keys
  strategies/        the five implementations, one file each
scripts/
  verify.js          build + correctness gate + smoke run
  verify-fairness.js identical DOM, exact floors, every field compared
  headless.js        scripted runs, CPU throttling, CSV output
```

---

## Prior art

[js-framework-benchmark](https://github.com/krausest/js-framework-benchmark) for
breadth across frameworks, [Speedometer 3](https://browserbench.org/Speedometer3.0/)
for methodological rigour, and Rich Harris's
[Virtual DOM is pure overhead](https://svelte.dev/blog/virtual-dom-is-pure-overhead)
for the argument this experiment measures.
