// Balanced measurement runner.
//
//   node scripts/headless.js [--matrix] [--rows N] [--iterations I]
//     [--rotations R] [--repeat P] [--throttle T] [--csv file] [--chrome path]
//
// Balancing:
//   · strategy order rotates within every cell (R rotations, pooled);
//   · scenario order alternates forward/reverse between Chrome processes, so
//     no mutation kind is permanently correlated with warm-up or heap growth;
//   · each repeat is a FRESH Chrome process — only that resets JIT and GC state.
//
// With --csv it also writes:
//   <name>.raw.json       raw samples grouped by process → scenario → strategy.
//                         Within each array, samples are rotation-major:
//                         rotation k = samples[k*iterations .. (k+1)*iterations).
//                         Asserted: samples.length === rotations * iterations.
//   <name>.manifest.json  environment + command + scenario order per process.
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync } from 'node:fs'
import os from 'node:os'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.js'

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const ROWS = Number(arg('rows', 1000))
const THROTTLE = Number(arg('throttle', 1))
const ITER = Number(arg('iterations', 15))
const CSV = arg('csv', null)
const PORT = 4179
const CHROME = resolveChrome(arg('chrome', null))
const MEMO = process.argv.includes('--memo')
const MATRIX = process.argv.includes('--matrix')
const ROTATIONS = Number(arg('rotations', 5))
const REPEATS = Number(arg('repeat', 1))
const WARMUP = 3

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  stdio: 'ignore',
})
const shutdown = () => preview.kill()
process.on('exit', shutdown)
process.on('SIGINT', () => { shutdown(); process.exit(1) })

async function waitForServer(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error('vite preview did not come up — did you run `npx vite build` first?')
}
await waitForServer(`http://localhost:${PORT}/`)

const pageErrors = []
const perProcess = []
let idsForward = null
let browserVersion = null
let resultsById = new Map()

for (let rep = 0; rep < REPEATS; rep++) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 0,
  })
  try {
    browserVersion = await browser.version()
    const page = await browser.newPage()
    page.on('pageerror', (e) => pageErrors.push(`process ${rep}: ${e.message}`))
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`process ${rep} console.error: ${m.text()}`) })
    // Fixed publication viewport; Puppeteer's 800x600 default left the stage
    // below the fold, which governs the presentation-oriented e2e column.
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' })

    const vis = await page.evaluate(() => {
      const el = document.getElementById('stage')
      el.scrollIntoView({ block: 'center' })
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, vh: window.innerHeight, width: r.width }
    })
    if (!(vis.top >= 0 && vis.bottom <= vis.vh)) {
      throw new Error(`stage not fully in viewport: top=${vis.top} bottom=${vis.bottom} vh=${vis.vh}`)
    }
    if (rep === 0) process.stderr.write(`  stage ${vis.width.toFixed(0)}px wide, fully visible in 1440x900\n`)

    if (THROTTLE > 1) {
      const client = await page.createCDPSession()
      await client.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
    }

    idsForward = await page.evaluate((matrix) =>
      (matrix ? window.__bench.MATRIX : window.__bench.SCENARIOS).map((s) => s.id), MATRIX)
    // Odd processes run the scenarios in reverse, so no kind is always measured
    // on a cold (or a heat-soaked) process.
    const order = rep % 2 === 1 ? [...idsForward].reverse() : idsForward

    const cells = {}
    for (let i = 0; i < order.length; i++) {
      const id = order[i]
      const idx = idsForward.indexOf(id)
      process.stderr.write(`  process ${rep + 1}/${REPEATS}  cell ${i + 1}/${order.length}  ${id}          \r`)
      const res = await page.evaluate(async (rows, iterations, memo, matrix, rotations, idx, warmup) => {
        const set = matrix ? window.__bench.MATRIX : window.__bench.SCENARIOS
        return window.__bench.run({
          scenario: set[idx], n: rows, memoized: memo, warmup, iterations,
          rotate: idx, rotations,
        })
      }, ROWS, ITER, MEMO, MATRIX, ROTATIONS, idx, WARMUP)

      cells[id] = {}
      for (const r of res.rows) {
        // Contract check: rotation-major layout only holds if nothing was lost.
        if (r.samples.script.length !== ROTATIONS * ITER) {
          throw new Error(`${id}/${r.strategy}: ${r.samples.script.length} samples != rotations*iterations`)
        }
        cells[id][r.strategy] = r.samples
      }
      resultsById.set(id, res)
    }
    process.stderr.write('\n')
    perProcess.push({ process: rep, scenarioOrder: order, cells })
  } finally {
    await browser.close()
  }
}

// ── Pool across processes and re-summarise ───────────────────────────────────
const quantile = (sorted, q) => {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos), hi = Math.ceil(pos)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
const summarise = (a) => {
  const s = a.slice().sort((x, y) => x - y)
  return { p50: quantile(s, 0.5), p95: quantile(s, 0.95), n: s.length }
}
const median = (a) => quantile(a.slice().sort((x, y) => x - y), 0.5)

const results = idsForward.map((id) => resultsById.get(id))
for (const res of results) {
  for (const r of res.rows) {
    const pooled = {}
    for (const proc of perProcess) {
      const samples = proc.cells[res.scenario][r.strategy]
      for (const k of Object.keys(samples)) (pooled[k] ??= []).push(...samples[k])
    }
    r.pooled = pooled
    r.script = summarise(pooled.script)
    r.layout = summarise(pooled.layout)
    r.total = summarise(pooled.total)
    r.e2e = summarise(pooled.e2e)
    r.render = pooled.render.length ? summarise(pooled.render) : null
    r.commit = pooled.commit.length ? summarise(pooled.commit) : null
    r.tail = pooled.tail.length ? summarise(pooled.tail) : null
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const pad = (s, w) => String(s).padStart(w)
const padr = (s, w) => String(s).padEnd(w)
const samplesPerCell = ROTATIONS * ITER * REPEATS

console.log(`\nN=${ROWS}  iterations=${ITER}  rotations=${ROTATIONS}  processes=${REPEATS}` +
  `  cpu=${THROTTLE}x  memo=${MEMO ? 'on' : 'off'}  (${samplesPerCell} pooled samples/cell)\n`)

for (const res of results) {
  console.log(`${res.label}   floor: ${res.minOps} ops (${res.minDesc})`)
  console.log(
    '  ' + padr('strategy', 30) + pad('ops', 9) + pad('vs floor', 10) +
    pad('script', 9) + pad('layout', 9) + pad('total', 9) + pad('p95', 9) +
    pad('vs targeted', 13) + pad('vs keyed', 10),
  )
  const base = (name) => {
    const row = res.rows.find((x) => x.strategy === name)
    return row && row.total ? row.total.p50 : null
  }
  const bTargeted = base('vanilla JS · targeted')
  const bKeyed = base('vanilla JS · keyed diff')
  const delta = (v, b) => (b == null || v == null ? '—'
    : (v - b >= 0 ? '+' : '') + (v - b).toFixed(2))
  for (const r of res.rows) {
    console.log(
      '  ' + padr(r.strategy, 30) +
      pad(r.ops.total, 9) +
      pad(res.minOps ? '×' + (r.ops.total / res.minOps).toFixed(2) : '—', 10) +
      pad(r.script.p50.toFixed(2), 9) +
      pad(r.layout.p50.toFixed(2), 9) +
      pad(r.total.p50.toFixed(2), 9) +
      pad(r.total.p95.toFixed(2), 9) +
      pad(delta(r.total.p50, bTargeted), 13) +
      pad(delta(r.total.p50, bKeyed), 10),
    )
  }
  console.log('')
}

// Per-process premiums: pooling is descriptive; the process-level view is what
// shows whether the direction held independently.
if (REPEATS > 1) {
  console.log('per-process react − targeted (median across scenarios of per-process total medians):')
  for (const proc of perProcess) {
    const premiums = idsForward.map((id) => {
      const c = proc.cells[id]
      const r = c['react · key={row.id}'], t = c['vanilla JS · targeted']
      return r && t ? median(r.total) - median(t.total) : null
    }).filter((v) => v != null)
    console.log(`  process ${proc.process + 1} (${proc.scenarioOrder[0] === idsForward[0] ? 'forward' : 'reverse'} order): ` +
      `+${median(premiums).toFixed(2)} ms  (range ${Math.min(...premiums).toFixed(2)} to ${Math.max(...premiums).toFixed(2)})`)
  }
  console.log('')
}

// ── Artifacts ────────────────────────────────────────────────────────────────
if (CSV) {
  const head = 'scenario,n,cpu,strategy,samples,dom_ops,floor_ops,added,removed,attrs,text,' +
    'script_p50,script_p95,layout_p50,total_p50,total_p95,e2e_p50,render_p50,commit_p50,tail_p50'
  const lines = [head]
  for (const res of results) {
    for (const r of res.rows) {
      lines.push([
        res.scenario, res.n, THROTTLE, `"${r.strategy}"`, r.total.n, r.ops.total, res.minOps,
        r.ops.added, r.ops.removed, r.ops.attrs, r.ops.text,
        r.script.p50.toFixed(4), r.script.p95.toFixed(4),
        r.layout.p50.toFixed(4),
        r.total.p50.toFixed(4), r.total.p95.toFixed(4),
        r.e2e.p50.toFixed(4),
        r.render ? r.render.p50.toFixed(4) : '',
        r.commit ? r.commit.p50.toFixed(4) : '',
        r.tail ? r.tail.p50.toFixed(4) : '',
      ].join(','))
    }
  }
  writeFileSync(CSV, lines.join('\n') + '\n')

  const stem = CSV.replace(/\.csv$/, '')
  writeFileSync(stem + '.raw.json', JSON.stringify({
    contract: 'processes[].cells[scenario][strategy] = {script,layout,total,e2e,render,commit,tail}; ' +
      'each array is rotation-major: rotation k = samples[k*iterations .. (k+1)*iterations)',
    iterations: ITER, rotations: ROTATIONS,
    processes: perProcess,
  }, null, 1))

  const reactVersion = JSON.parse(readFileSync('node_modules/react/package.json', 'utf8')).version
  writeFileSync(stem + '.manifest.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    command: 'node scripts/headless.js ' + process.argv.slice(2).join(' '),
    rows: ROWS, iterations: ITER, warmup: WARMUP, rotations: ROTATIONS,
    processes: REPEATS, cpuThrottle: THROTTLE, memo: MEMO, matrix: MATRIX,
    samplesPerCell,
    scenarioOrderPerProcess: perProcess.map((p) => p.scenarioOrder),
    viewport: '1440x900',
    chrome: browserVersion,
    react: reactVersion,
    node: process.version,
    os: { platform: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model },
    files: { csv: CSV, raw: stem + '.raw.json' },
    note: 'Repeated runs are separate runs on the same machine, not independent replications.',
  }, null, 2))
  console.log(`wrote ${CSV}, ${stem}.raw.json, ${stem}.manifest.json`)
}

if (pageErrors.length) {
  console.error('\nPAGE ERRORS — run is invalid:')
  for (const e of pageErrors.slice(0, 10)) console.error('  ' + e)
  preview.kill()
  process.exit(1)
}
preview.kill()
