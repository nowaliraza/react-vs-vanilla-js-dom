import { createOpCounter, summarize, forceLayout, nextFrame, afterPaint } from './measure.js'
import { createInnerHTMLStrategy } from './strategies/vanillaInnerHTML.js'
import { createKeyedDiffStrategy, COMPARED_FIELDS } from './strategies/vanillaKeyedDiff.js'
import { createSurgicalStrategy } from './strategies/vanillaSurgical.js'
import { createReactStrategy } from './strategies/react.jsx'
import { createReactStoreStrategy } from './strategies/reactStore.jsx'

// The default line-up: a realistic ceiling, a fair like-for-like comparison,
// the floor, and React with each key strategy.
export function buildStrategies({ memoized, profiled }) {
  return [
    () => createInnerHTMLStrategy(),
    () => createKeyedDiffStrategy(),
    () => createSurgicalStrategy(),
    () => createReactStrategy({ keyed: true, memoized, profiled }),
    () => createReactStrategy({ keyed: false, memoized, profiled }),
  ]
}

// The re-render scope staircase, in two groups — because two variables move
// across the full set, not one.
//
// Group A all receive the same thing React receives: the entire next-state
// array. Only the re-render scope differs, so these are directly comparable.
//
// Group B receive the change already addressed to a row. That is a different
// information contract, not just a smaller re-render, and mixing the two groups
// into one ranking would smuggle the contract change in as if it were a scope
// change.
export function buildScopeStateStrategies() {
  return [
    () => createReactStrategy({ keyed: true, memoized: false, name: 'react · state at root' }),
    () => createReactStrategy({ keyed: true, memoized: true, name: 'react · state at root + memo' }),
    () => createReactStoreStrategy(),
  ]
}

export function buildScopeTargetedStrategies() {
  return [
    () => createReactStoreStrategy({ targetedWrite: true }),
    () => createSurgicalStrategy(),
  ]
}

export { COMPARED_FIELDS, createKeyedDiffStrategy }

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// ── Pass 1: timing. The MutationObserver is NOT attached. ────────────────────
// Measured cost of having it attached is +0.2 to +0.7ms depending on scenario —
// small in absolute terms, but that is up to a quarter of React's update-one-row
// figure, which is the headline number. So the two passes are kept apart.
async function timingPass({ stage, makeStrategy, plan, warmup, iterations }) {
  const container = document.createElement('div')
  container.className = 'bench-container'
  stage.appendChild(container)

  const strategy = makeStrategy()
  strategy.mount(container)

  const script = []
  const layout = []
  const e2e = []
  const render = []
  const commit = []
  const tail = []

  for (let i = 0; i < warmup + iterations; i++) {
    strategy.reset(plan.base)
    forceLayout(container)

    const t0 = performance.now()
    strategy.apply(plan.next, plan.ops)
    const t1 = performance.now()
    forceLayout(container)
    const t2 = performance.now()

    const marks = strategy.marks()
    // Wait for the frame carrying this update to be presented. This is quantised
    // to the frame boundary, so it answers "did the update fit in a frame?"
    // rather than "how much work was it". Reported, never headlined.
    await afterPaint()
    const t3 = performance.now()

    if (i >= warmup) {
      script.push(t1 - t0)
      layout.push(t2 - t1)
      e2e.push(t3 - t0)
      if (marks && marks.renderMark) {
        render.push(marks.renderMark - t0)
        commit.push(marks.commitMark - marks.renderMark)
        tail.push(t1 - marks.commitMark)
      }
    }
  }

  strategy.unmount()
  container.remove()

  return {
    strategy: strategy.name,
    kind: strategy.kind,
    note: strategy.note,
    // Raw samples, not just p50/p95. Pooling across rotations and browser
    // processes has to happen on samples, and an outlier is only diagnosable
    // if you can still see the distribution it came from.
    samples: {
      script, layout, e2e, render, commit, tail,
      total: script.map((v, i) => v + layout[i]),
    },
    script: summarize(script),
    layout: summarize(layout),
    // Script and layout are not independent: how a strategy mutates the DOM
    // decides how much the browser must re-lay-out. Rebuilding every node
    // invalidates everything; touching one text node invalidates almost
    // nothing. So the honest comparison is the sum, and it is reported as its
    // own column rather than left for the reader to add up.
    total: summarize(script.map((v, i) => v + layout[i])),
    e2e: summarize(e2e),
    render: render.length ? summarize(render) : null,
    commit: commit.length ? summarize(commit) : null,
    tail: tail.length ? summarize(tail) : null,
  }
}

// ── Pass 2: instrumentation. Times from this pass are discarded. ─────────────
// Op counts are deterministic, so a handful of iterations is plenty — this is a
// count, not a sample.
async function opsPass({ stage, makeStrategy, plan, iterations = 3 }) {
  const container = document.createElement('div')
  container.className = 'bench-container'
  stage.appendChild(container)

  const strategy = makeStrategy()
  const counter = createOpCounter()
  strategy.mount(container)
  counter.attach(container)

  const samples = []
  for (let i = 0; i < iterations + 1; i++) {
    strategy.reset(plan.base)
    counter.drain()
    strategy.apply(plan.next, plan.ops)
    const ops = counter.take()
    if (i > 0) samples.push(ops)
    await nextFrame()
  }

  counter.detach()
  strategy.unmount()
  container.remove()

  const totals = samples.map((o) => o.total)
  return {
    total: median(totals),
    added: median(samples.map((o) => o.added)),
    removed: median(samples.map((o) => o.removed)),
    attrs: median(samples.map((o) => o.attrs)),
    text: median(samples.map((o) => o.text)),
    records: median(samples.map((o) => o.records)),
    stable: totals.every((v) => v === totals[0]),
  }
}

export async function runScenario({
  stage, scenario, n, memoized, profiled = false, warmup, iterations,
  rotate = 0, strategies, rotations = 1,
}) {
  const plan = scenario.build(n)
  const factories = strategies || buildStrategies({ memoized, profiled })

  // Measure every cell under `rotations` different starting orders and pool the
  // raw samples. Running all iterations of one strategy as a single block means
  // each strategy sees one particular thermal/GC state; rotating the start
  // position once per scenario only spreads that across scenarios, not within
  // a cell. Pooling across all rotations is what actually balances it.
  const pooled = new Map()
  for (let rot = 0; rot < rotations; rot++) {
    const shift = (rotate + rot) % factories.length
    const ordered = factories.slice(shift).concat(factories.slice(0, shift))
    for (const makeStrategy of ordered) {
      const timed = await timingPass({ stage, makeStrategy, plan, warmup, iterations })
      const prev = pooled.get(timed.strategy)
      if (!prev) {
        pooled.set(timed.strategy, { ...timed, ops: null })
      } else {
        // Every measured series, not just the four headline ones — the React
        // phase columns have to be balanced across rotations too, or the table
        // mixes pooled totals with first-rotation phase splits.
        for (const key of Object.keys(timed.samples)) {
          prev.samples[key].push(...timed.samples[key])
        }
      }
    }
  }

  const rows = []
  for (const makeStrategy of factories) {
    const name = makeStrategy().name
    const entry = pooled.get(name)
    entry.ops = await opsPass({ stage, makeStrategy, plan })
    entry.script = summarize(entry.samples.script)
    entry.layout = summarize(entry.samples.layout)
    entry.total = summarize(entry.samples.total)
    entry.e2e = summarize(entry.samples.e2e)
    entry.render = entry.samples.render.length ? summarize(entry.samples.render) : null
    entry.commit = entry.samples.commit.length ? summarize(entry.samples.commit) : null
    entry.tail = entry.samples.tail.length ? summarize(entry.samples.tail) : null
    rows.push(entry)
  }

  const canonical = factories.map((f) => f().name)
  rows.sort((a, b) => canonical.indexOf(a.strategy) - canonical.indexOf(b.strategy))

  return {
    scenario: scenario.id,
    label: scenario.label,
    desc: scenario.desc,
    minDesc: scenario.minDesc,
    minOps: plan.minOps,
    changed: plan.changed,
    n,
    rows,
  }
}
