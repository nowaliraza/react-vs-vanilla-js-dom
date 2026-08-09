import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SCENARIOS, MATRIX, densityScenario } from './scenarios.js'
import {
  runScenario, buildScopeStateStrategies, buildScopeTargetedStrategies,
  buildStrategies, createKeyedDiffStrategy, COMPARED_FIELDS,
} from './runner.js'
import { KeysDemo } from './KeysDemo.jsx'
import { nextFrame } from './measure.js'
import './style.css'

const DENSITIES = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1]
const fmt = (v, d = 2) => (v == null ? '—' : v.toFixed(d))
const num = (v) => (v == null ? '—' : v.toLocaleString())

function BuildBanner() {
  if (!import.meta.env.PROD) {
    return (
      <div className="banner bad">
        <strong>Development build — these numbers are not valid.</strong>
        Dev React carries warnings, invariants and extra bookkeeping, and runs
        several times slower than production. Explore here, but measure with
        <code>npm run measure</code>.
      </div>
    )
  }
  return (
    <div className="banner ok">
      <strong>Production build.</strong>
      Untouched production React{__PROFILING__ ? ' (profiling runtime — cross-check mode)' : ''}.
      The render/commit split comes from a single marker fiber, not from{' '}
      <code>&lt;Profiler&gt;</code>: on a 1000-row list a Profiler wrapper turns a
      3ms update into a 32ms one, so it cannot be used to explain the update it
      is inflating.
    </div>
  )
}

function OpsCell({ ops, minOps }) {
  const ratio = minOps > 0 ? ops.total / minOps : 0
  const cls = ratio <= 1.001 ? 'floor' : ratio < 3 ? 'near' : 'far'
  return (
    <>
      <td className="n strong">{num(ops.total)}</td>
      <td className={'n ratio ' + cls}>
        {minOps > 0 ? '×' + ratio.toFixed(ratio < 10 ? 2 : 0) : '—'}
      </td>
    </>
  )
}

function ResultTable({ result, breakdown }) {
  const maxTotal = Math.max(...result.rows.map((r) => (r.total ? r.total.p50 : 0)))
  // The README warns that orderings are not trustworthy at low iteration counts.
  // The UI let you set 3 and showed the results with no caveat at all.
  const samples = result.rows[0]?.script?.n ?? result.samples
  const thin = samples != null && samples < 20
  return (
    <section className="result">
      <header>
        <h3>
          {result.label}
          <span className="muted"> · N={num(result.n)}</span>
        </h3>
        <p className="desc">{result.desc}</p>
        <p className="floor-note">
          Floor: <strong>{num(result.minOps)}</strong> ops — {result.minDesc}
          {samples != null && (
            <span className={thin ? 'samples warn-samples' : 'samples'}>
              {' · '}{samples} samples{thin ? ' — too few to trust the ordering' : ''}
            </span>
          )}
        </p>
      </header>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th className="n">DOM ops</th>
              <th className="n">vs floor</th>
              {breakdown && (
                <>
                  <th className="n">+add</th>
                  <th className="n">−rem</th>
                  <th className="n">attr</th>
                  <th className="n">text</th>
                </>
              )}
              <th className="n">script</th>
              <th className="n">layout</th>
              <th className="n">total ms</th>
              <th className="bar-col" title="share of the slowest strategy in this scenario">
                relative to slowest
              </th>
              <th className="n">p95 total</th>
              <th className="n">render</th>
              <th className="n">commit</th>
              <th className="n">e2e</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.strategy} className={r.kind}>
                <td>
                  <span className="sname">{r.strategy}</span>
                  <span className="snote">{r.note}</span>
                  {!r.ops.stable && <span className="warn" title="op count varied between iterations">⚠</span>}
                </td>
                <OpsCell ops={r.ops} minOps={result.minOps} />
                {breakdown && (
                  <>
                    <td className="n dim">{num(r.ops.added)}</td>
                    <td className="n dim">{num(r.ops.removed)}</td>
                    <td className="n dim">{num(r.ops.attrs)}</td>
                    <td className="n dim">{num(r.ops.text)}</td>
                  </>
                )}
                <td className="n dim">{fmt(r.script.p50)}</td>
                <td className="n dim">{fmt(r.layout.p50)}</td>
                <td className="n headline">{r.total ? fmt(r.total.p50) : '—'}</td>
                <td className="bar-col">
                  {/* A number is hard to compare across five rows; a bar is not.
                      Scaled to the slowest strategy in this scenario. */}
                  <span className="bar" aria-hidden="true" style={{
                    width: (r.total && maxTotal ? Math.max(1.5, (r.total.p50 / maxTotal) * 100) : 0) + '%',
                  }} />
                  <span className="sr-only">
                    {r.total && maxTotal
                      ? Math.round((r.total.p50 / maxTotal) * 100) + '% of slowest'
                      : 'no data'}
                  </span>
                </td>
                <td className="n dim">{r.total ? fmt(r.total.p95) : '—'}</td>
                <td className="n dim">{r.render ? fmt(r.render.p50) : '—'}</td>
                <td className="n dim">{r.commit ? fmt(r.commit.p50) : '—'}</td>
                <td className="n dim">{r.e2e ? fmt(r.e2e.p50) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

const SERIES_COLOURS = {
  'vanilla JS · rebuild': '#e0803a',
  'vanilla JS · keyed diff': '#d4b74a',
  'vanilla JS · targeted': '#4fa86b',
  'react · key={row.id}': '#4a8fd4',
  'react · key={index}': '#b062c4',
}

function DensityChart({ sweep }) {
  if (!sweep) return null
  const W = 940, H = 340, PAD = { l: 70, r: 250, t: 18, b: 44 }
  const names = sweep.series.map((s) => s.name)
  const all = sweep.series.flatMap((s) => s.points.map((p) => p.y)).filter((v) => v > 0)
  // A little headroom so the extreme points do not sit exactly on the axes.
  const lo = Math.min(...all) / 1.4, hi = Math.max(...all) * 1.4
  // Log Y: rebuild and targeted differ by orders of magnitude, so a linear
  // axis would flatten everything interesting into the baseline.
  const ly = (v) => Math.log10(Math.max(v, lo / 2))
  const y = (v) => PAD.t + (H - PAD.t - PAD.b) * (1 - (ly(v) - ly(lo)) / (ly(hi) - ly(lo) || 1))
  const x = (i) => PAD.l + (W - PAD.l - PAD.r) * (i / (sweep.densities.length - 1))

  // Only decades that actually fall inside the data range — otherwise a tick
  // gets clamped and drawn outside the plot area.
  const ticks = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    const t = 10 ** e
    if (t >= lo && t <= hi) ticks.push(t)
  }
  const tickLabel = (t) =>
    t.toFixed(Math.max(0, -Math.round(Math.log10(t)))) + 'ms'

  return (
    <section className="result">
      <header>
        <h3>Cost vs update density <span className="muted"> · N={num(sweep.n)}</span></h3>
        <p className="desc">
          Script <em>plus</em> layout — total browser work — as a function of how
          much of the list actually changed. Plotting script alone would hide the
          largest single cost of rebuilding: the layout invalidation it causes.
        </p>
      </header>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.l - 10} y={y(t) + 4} className="axis" textAnchor="end">
              {tickLabel(t)}
            </text>
          </g>
        ))}
        {sweep.densities.map((d, i) => (
          <text key={d} x={x(i)} y={H - PAD.b + 20} className="axis" textAnchor="middle">
            {d * 100 < 1 ? (d * 100).toFixed(1) : d * 100}%
          </text>
        ))}
        <text x={(PAD.l + W - PAD.r) / 2} y={H - 6} className="axis label" textAnchor="middle">
          rows changed
        </text>
        {sweep.series.map((s) => (
          <g key={s.name}>
            <polyline
              points={s.points.map((p, i) => `${x(i)},${y(p.y)}`).join(' ')}
              fill="none"
              stroke={SERIES_COLOURS[s.name]}
              strokeWidth="2"
            />
            {s.points.map((p, i) => (
              <circle key={i} cx={x(i)} cy={y(p.y)} r="3" fill={SERIES_COLOURS[s.name]} />
            ))}
          </g>
        ))}
        {names.map((nm, i) => (
          <g key={nm}>
            <rect x={W - PAD.r + 12} y={PAD.t + i * 22} width="10" height="10" fill={SERIES_COLOURS[nm]} />
            <text x={W - PAD.r + 28} y={PAD.t + i * 22 + 9} className="axis">{nm}</text>
          </g>
        ))}
      </svg>
    </section>
  )
}

function toCSV(results) {
  const head = ['scenario', 'n', 'strategy', 'dom_ops', 'floor_ops', 'added', 'removed', 'attrs', 'text', 'script_p50', 'script_p95', 'layout_p50', 'total_p50', 'render_p50', 'commit_p50', 'tail_p50', 'e2e_p50']
  const lines = [head.join(',')]
  for (const res of results) {
    for (const r of res.rows) {
      lines.push([
        res.scenario, res.n, `"${r.strategy}"`, r.ops.total, res.minOps,
        r.ops.added, r.ops.removed, r.ops.attrs, r.ops.text,
        r.script.p50.toFixed(4), r.script.p95.toFixed(4),
        r.layout.p50.toFixed(4), r.total ? r.total.p50.toFixed(4) : '',
        r.render ? r.render.p50.toFixed(4) : '',
        r.commit ? r.commit.p50.toFixed(4) : '',
        r.tail ? r.tail.p50.toFixed(4) : '',
        r.e2e ? r.e2e.p50.toFixed(4) : '',
      ].join(','))
    }
  }
  return lines.join('\n')
}

function App() {
  const [n, setN] = useState(1000)
  const [iterations, setIterations] = useState(25)
  const [warmup, setWarmup] = useState(5)
  const [memoized, setMemoized] = useState(false)
  const [breakdown, setBreakdown] = useState(false)
  const [results, setResults] = useState([])
  const [sweep, setSweep] = useState(null)
  const [scope, setScope] = useState(null)
  const [matrix, setMatrix] = useState([])
  const [busy, setBusy] = useState(false)
  const progressRef = useRef(null)

  const stage = () => document.getElementById('stage')
  // Written imperatively: a React state update here would schedule harness
  // renders inside the measurement window and pollute the numbers.
  const say = (msg) => {
    if (progressRef.current) progressRef.current.textContent = msg
  }

  async function runAll() {
    setBusy(true)
    setResults([])
    setSweep(null)
    setScope(null)
    setMatrix([])
    await nextFrame()
    const out = []
    for (let i = 0; i < SCENARIOS.length; i++) {
      const sc = SCENARIOS[i]
      say(`${i + 1}/${SCENARIOS.length} · ${sc.label}`)
      await nextFrame()
      out.push(await runScenario({
        stage: stage(), scenario: sc, n, memoized, warmup, iterations, rotate: i,
      }))
      setResults(out.slice())
      await nextFrame()
    }
    say('done')
    setBusy(false)
  }

  async function runOneScenario(sc, i) {
    setBusy(true)
    say(sc.label)
    await nextFrame()
    const res = await runScenario({
      stage: stage(), scenario: sc, n, memoized, warmup, iterations, rotate: i,
    })
    setResults((prev) => [...prev.filter((r) => r.scenario !== res.scenario), res])
    say('done')
    setBusy(false)
  }

  // One visible change, several ways of arranging React around it — reported in
  // two groups, because two variables move across the full set.
  //
  // Group A all receive the entire next-state array, exactly as React does, so
  // only the re-render scope differs and they rank against each other honestly.
  // Group B are handed the change already addressed to a row. That is a
  // different information contract, not a smaller re-render, and folding it into
  // one ranking would present a contract change as if it were a scope change.
  async function runScope() {
    setBusy(true)
    setScope(null)
    await nextFrame()
    const sc = SCENARIOS.find((s) => s.id === 'update1')

    say('scope · same next-state input')
    const a = await runScenario({
      stage: stage(), scenario: sc, n, memoized: false, warmup, iterations,
      strategies: buildScopeStateStrategies(),
    })
    a.label = 'Re-render scope — same input as React'
    a.desc = 'All three receive the whole next-state array and must find the change in it. Only the amount of component tree re-checked differs, so these rank against each other honestly.'

    await nextFrame()
    say('scope · target-addressed input')
    const b = await runScenario({
      stage: stage(), scenario: sc, n, memoized: false, warmup, iterations,
      strategies: buildScopeTargetedStrategies(),
    })
    b.label = 'Re-render scope — target-addressed input'
    b.desc = 'These two are handed the change already addressed to a row, so nothing scans. That is a different information contract, not merely a smaller re-render — which is why it is a separate table.'

    setScope([a, b])
    say('done')
    setBusy(false)
  }

  // 7 mutation kinds x 2 densities. Same list, same data, same CSS; the only
  // thing that varies is what kind of DOM change the update requires.
  //
  // This runs ONE starting order. It is for exploring, not for publishing:
  // single-order cells produce visible outliers. Publication numbers come from
  // `node scripts/headless.js --matrix --rotations 5 --repeat 2`, which pools
  // every order across fresh browser processes.
  async function runMatrix() {
    setBusy(true)
    setMatrix([])
    await nextFrame()
    const out = []
    for (let i = 0; i < MATRIX.length; i++) {
      say(`matrix ${i + 1}/${MATRIX.length} · ${MATRIX[i].label}`)
      await nextFrame()
      out.push(await runScenario({
        stage: stage(), scenario: MATRIX[i], n, memoized, warmup, iterations, rotate: i,
      }))
      setMatrix(out.slice())
      await nextFrame()
    }
    say('done')
    setBusy(false)
  }

  async function runSweep() {
    setBusy(true)
    setSweep(null)
    await nextFrame()
    const bucket = new Map()
    for (let i = 0; i < DENSITIES.length; i++) {
      const d = DENSITIES[i]
      say(`sweep ${i + 1}/${DENSITIES.length} · ${(d * 100).toFixed(1)}% of rows`)
      await nextFrame()
      const res = await runScenario({
        stage: stage(), scenario: densityScenario(d), n, memoized, warmup, iterations, rotate: i,
      })
      for (const r of res.rows) {
        if (!bucket.has(r.strategy)) bucket.set(r.strategy, [])
        bucket.get(r.strategy).push({ d, y: r.total ? r.total.p50 : r.script.p50 })
      }
      await nextFrame()
    }
    setSweep({
      n,
      densities: DENSITIES,
      series: [...bucket].map(([name, points]) => ({ name, points })),
    })
    say('done')
    setBusy(false)
  }

  return (
    <div className="app">
      <h1>Virtual DOM dissection</h1>
      <p className="lede">
        Five strategies producing byte-identical DOM, measured on the same page:
        how many DOM operations each performs, and where React's time goes
        between render phase, commit phase and browser layout.
      </p>

      <BuildBanner />

      <div className="controls">
        <label>
          rows
          <select value={n} onChange={(e) => setN(+e.target.value)} disabled={busy}>
            {[100, 500, 1000, 5000, 10000].map((v) => <option key={v} value={v}>{num(v)}</option>)}
          </select>
        </label>
        <label>
          iterations
          <input type="number" min="5" max="200" value={iterations} disabled={busy}
            onChange={(e) => setIterations(+e.target.value)} />
        </label>
        <label>
          warmup
          <input type="number" min="0" max="50" value={warmup} disabled={busy}
            onChange={(e) => setWarmup(+e.target.value)} />
        </label>
        <label className="check">
          <input type="checkbox" checked={memoized} disabled={busy}
            onChange={(e) => setMemoized(e.target.checked)} />
          React.memo rows
        </label>
        <label className="check">
          <input type="checkbox" checked={breakdown}
            onChange={(e) => setBreakdown(e.target.checked)} />
          op breakdown
        </label>
        <div className="spacer" />
        <button className="primary" onClick={runAll} disabled={busy}>Run all scenarios</button>
        <button onClick={runMatrix} disabled={busy}
          title="Single starting order — exploratory. Use npm run matrix for balanced numbers.">
          Mutation matrix
        </button>
        <button onClick={runScope} disabled={busy}>Scope staircase</button>
        <button onClick={runSweep} disabled={busy}>Density sweep</button>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(toCSV(results))
              say(`copied ${results.length} scenarios as CSV`)
            } catch (err) {
              say('clipboard blocked — ' + err.message)
            }
          }}
          disabled={busy || !results.length}
        >Copy CSV</button>
        <span className="progress" ref={progressRef} role="status" aria-live="polite" />
      </div>

      <div className="scenario-buttons">
        {SCENARIOS.map((sc, i) => (
          <button key={sc.id} disabled={busy} onClick={() => runOneScenario(sc, i)}>
            {sc.label}
          </button>
        ))}
      </div>

      <details className="notes">
        <summary>How to read these numbers</summary>
        <p>
          <strong>DOM ops</strong> counts MutationObserver records on the live
          tree — nodes added, nodes removed, attributes written, text nodes
          written. It is an integer, identical run to run, so it needs no
          statistics. Subtrees built detached and appended in one shot are
          invisible to it; that is the optimisation, not a gap in the ruler.
        </p>
        <p>
          <strong>script</strong> is the whole synchronous window around the
          update. For React that is <code>flushSync</code>, so nothing is
          deferred out of the timer. Inside it:{' '}
          <strong>render</strong> — component functions and reconciliation, up to
          the last row rendered. <strong>commit</strong> — the mutation phase,
          the actual DOM writes. <strong>tail</strong> — layout effects and
          teardown, after the DOM is already correct.
        </p>
        <p>
          <strong>layout</strong> is the forced style+layout flush afterwards,
          and it is <em>not</em> the same for every strategy even though they all
          produce the same tree. The browser re-lays-out what was
          <em>invalidated</em>, not what exists: rebuilding every node
          invalidates everything, writing one text node invalidates almost
          nothing. On update-one-row at N=1000 that is 20ms versus 0.5ms.
          <strong>total</strong> = script + layout, and it is the honest headline
          — script alone understates the cost of strategies that churn the DOM.
        </p>
        <p>
          For throttled runs, open DevTools → Performance → CPU throttling, pick
          4× or 6×, and re-run. That is where the ratios stop being academic.
        </p>
        <p>
          <strong>Runs here use one starting order</strong>, which is enough to
          explore but produces occasional single-cell outliers. Numbers quoted in
          the README come from{' '}
          <code>scripts/headless.js --matrix --rotations 5 --repeat 2</code>,
          which pools every ordering across fresh browser processes.
        </p>
      </details>

      <section className="stage-frame">
        <h3>Live measured DOM</h3>
        <p>
          Every strategy renders into this slot while it is being timed. Keeping
          it on screen is mostly for transparency — you can watch the rows being
          updated. It does not affect <code>script</code> or <code>layout</code>,
          which are forced synchronously either way; it affects only{' '}
          <code>e2e</code>, which waits for the frame to be presented. The
          headless runner pins a 1440×900 viewport and asserts this panel is
          fully visible before measuring, so that column means the same thing on
          every run.
        </p>
        <div id="stage" />
      </section>

      {matrix.map((r) => (
        <ResultTable key={r.scenario} result={r} breakdown={breakdown} />
      ))}
      {scope && scope.map((r) => (
        <ResultTable key={r.label} result={r} breakdown={breakdown} />
      ))}
      {sweep && <DensityChart sweep={sweep} />}
      {results.map((r) => (
        <ResultTable key={r.scenario} result={r} breakdown={breakdown} />
      ))}
      <KeysDemo />
    </div>
  )
}

createRoot(document.getElementById('harness')).render(<App />)

// Same runner the buttons use, exposed for scripted runs (see scripts/headless.js).
// Driving it from outside the page keeps the harness UI from rendering at all
// during measurement, which is the cleanest possible condition.
window.__bench = {
  SCENARIOS,
  MATRIX,
  densityScenario,
  stage: () => document.getElementById('stage'),
  run: (opts) => runScenario({ stage: document.getElementById('stage'), ...opts }),
  // Used by scripts/verify-fairness.js, not by the page.
  internals: { buildStrategies, createKeyedDiffStrategy, COMPARED_FIELDS },
  runScopeState: (opts) => runScenario({
    stage: document.getElementById('stage'),
    strategies: buildScopeStateStrategies(),
    ...opts,
  }),
  runScopeTargeted: (opts) => runScenario({
    stage: document.getElementById('stage'),
    strategies: buildScopeTargetedStrategies(),
    ...opts,
  }),
}
