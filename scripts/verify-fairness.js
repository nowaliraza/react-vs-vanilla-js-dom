// Validity gate. Run before trusting any number in this project.
//
// Assertions, none of which implies the others:
//
//   1. IDENTICAL DOM: all five strategies produce the same final HTML.
//   2. SEMANTIC DOM: the DOM after reset(base) matches base, and after
//      apply(next) matches next — checked field by field against the row
//      objects by this script's own logic, sharing no rendering helpers with
//      any strategy. This catches the case where the scenario plan itself is
//      wrong and all five strategies faithfully agree on the wrong answer, and
//      it catches a faulty reset that apply() would silently repair.
//   3. FLOORS (matrix cells): every non-rebuild strategy performs exactly the
//      declared minimum — and exactly the declared BREAKDOWN of adds, removes,
//      attribute writes and text writes, since two wrong patterns can share a
//      total. List scenarios assert >= floor only: swap moving ~N nodes and
//      index keys rewriting everything ARE this project's findings.
//   4. COMPARISONS: the keyed-diff baseline actually inspected all six mutable
//      fields of the row contract on every row (matrix cells), counted at each
//      comparison site. Op counts cannot prove this.
//   5. SCHEMA: the row contract itself — id plus the six compared fields — has
//      not drifted. A new field cannot appear without being compared.
//   6. Page errors and console.error fail the run.
//
//   node scripts/verify-fairness.js [--rows N]   (default 1000)
import { spawn } from 'node:child_process'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.js'

const PORT = 4192
const argv = process.argv
const N = Number(argv.includes('--rows') ? argv[argv.indexOf('--rows') + 1] : 1000)
const CHROME = resolveChrome(argv.includes('--chrome') ? argv[argv.indexOf('--chrome') + 1] : null)

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' })
process.on('exit', () => preview.kill())
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`http://localhost:${PORT}/`)).ok) break } catch {}
  await new Promise((r) => setTimeout(r, 200))
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  protocolTimeout: 0,
})
const page = await browser.newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e.message)))
page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console.error: ' + m.text()) })
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' })

const report = await page.evaluate(async (rows) => {
  const { MATRIX, SCENARIOS } = window.__bench
  const { buildStrategies, createKeyedDiffStrategy, COMPARED_FIELDS } = window.__bench.internals
  const stage = document.getElementById('stage')
  const out = []
  const matrixIds = new Set(MATRIX.map((m) => m.id))

  const deepFreeze = (o) => {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o)
      for (const v of Object.values(o)) deepFreeze(v)
    }
    return o
  }

  // Independent semantic check: expected state derived from the row objects by
  // logic owned here. Shares nothing with any strategy's rendering code.
  function checkRows(container, rowsExpected, phase) {
    const els = container.children
    if (els.length !== rowsExpected.length) {
      return `${phase}: ${els.length} row elements, expected ${rowsExpected.length}`
    }
    for (let i = 0; i < rowsExpected.length; i++) {
      const r = rowsExpected[i], el = els[i]
      const fail = (what) => `${phase} row ${i} (id ${r.id}): ${what}`
      if (el.getAttribute('data-id') !== String(r.id)) return fail('data-id')
      if (el.getAttribute('data-status') !== r.status) return fail('data-status')
      if (el.classList.contains('active') !== r.active) return fail('active class')
      const rid = el.children[0], lab = el.children[1], badge = el.children[2]
      if (!rid || rid.textContent !== String(r.id)) return fail('rid text')
      if (!lab || lab.tagName.toLowerCase() !== r.tag) return fail(`tag (${lab && lab.tagName})`)
      if (lab.textContent !== r.label) return fail('label text')
      if (lab.style.color !== r.color) return fail(`color (${lab.style.color})`)
      if (Boolean(badge) !== r.badge) return fail('badge presence')
      if (badge && badge.textContent !== 'new') return fail('badge text')
    }
    return null
  }

  // Schema guard: the row contract is id + the six compared fields, exactly.
  const sampleRow = SCENARIOS.map((s) => s.build(3).base.rows[0]).find(Boolean)
  const schemaKeys = Object.keys(sampleRow).sort().join(',')
  const expectedKeys = ['id', ...COMPARED_FIELDS].sort().join(',')

  for (const scenario of [...SCENARIOS, ...MATRIX]) {
   try {
    const plan = deepFreeze(scenario.build(rows))
    const strict = matrixIds.has(scenario.id)
    const doms = []
    const ops = []
    const semanticErrors = []
    let comparisons = null

    const factories = [
      ...buildStrategies({ memoized: false, profiled: false }),
      () => createKeyedDiffStrategy({ instrument: true }),
    ]

    for (let fi = 0; fi < factories.length; fi++) {
      const container = document.createElement('div')
      container.className = 'bench-container'
      stage.appendChild(container)
      const strategy = factories[fi]()
      strategy.mount(container)

      strategy.reset(plan.base)
      const baseErr = checkRows(container, plan.base.rows, 'after reset')
      if (baseErr) semanticErrors.push(`${strategy.name}: ${baseErr}`)

      const obs = new MutationObserver(() => {})
      obs.observe(container, { childList: true, subtree: true, attributes: true, characterData: true })
      if (strategy.resetComparisons) strategy.resetComparisons()

      strategy.apply(plan.next, plan.ops)

      let added = 0, removed = 0, attrs = 0, text = 0
      for (const r of obs.takeRecords()) {
        if (r.type === 'childList') { added += r.addedNodes.length; removed += r.removedNodes.length }
        else if (r.type === 'attributes') attrs++
        else text++
      }
      obs.disconnect()

      const nextErr = checkRows(container, plan.next.rows, 'after apply')
      if (nextErr) semanticErrors.push(`${strategy.name}: ${nextErr}`)

      const isInstrumented = fi === factories.length - 1
      if (isInstrumented) comparisons = strategy.comparisons()
      else {
        doms.push({ name: strategy.name, html: container.innerHTML })
        ops.push({ name: strategy.name, added, removed, attrs, text, total: added + removed + attrs + text })
      }

      strategy.unmount()
      container.remove()
      await new Promise((r) => requestAnimationFrame(() => r()))
    }

    const ref = doms[0]
    const domMismatches = doms.filter((d) => d.html !== ref.html).map((d) => {
      let i = 0
      while (i < d.html.length && i < ref.html.length && d.html[i] === ref.html[i]) i++
      return { name: d.name, at: i,
        expected: ref.html.slice(Math.max(0, i - 40), i + 60),
        actual: d.html.slice(Math.max(0, i - 40), i + 60) }
    })

    out.push({
      scenario: scenario.id,
      strict,
      floor: plan.minOps,
      vector: plan.vector || null,
      ops,
      domMismatches,
      domRef: ref.name,
      semanticErrors,
      comparisons,
      expectedComparisons: rows * COMPARED_FIELDS.length,
    })
   } catch (err) {
    out.push({ scenario: scenario.id, error: String((err && err.message) || err) })
   }
  }
  return { rows: out, schemaKeys, expectedKeys }
}, N)

let failures = 0
const pad = (s, w) => String(s).padEnd(w)
const padn = (s, w) => String(s).padStart(w)

console.log(`\nFairness gate — N=${N}\n`)
if (report.schemaKeys !== report.expectedKeys) {
  failures++
  console.log(`  SCHEMA DRIFT: row keys [${report.schemaKeys}] != id + compared fields [${report.expectedKeys}]\n`)
}
console.log('  ' + pad('scenario', 18) + padn('floor', 7) + '  ' + pad('ops by strategy', 42) + ' DOM  SEM  VEC  compares')
for (const r of report.rows) {
  if (r.error) {
    failures++
    console.log('  ' + pad(r.scenario, 18) + '  THREW: ' + r.error)
    continue
  }
  const opsStr = r.ops.map((o) => o.total).join('/')
  const domOK = r.domMismatches.length === 0
  const semOK = r.semanticErrors.length === 0
  const cmpOK = r.strict ? r.comparisons === r.expectedComparisons : true
  const floorOK = r.strict
    ? r.ops.slice(1).every((o) => o.total === r.floor)
    : r.ops.every((o) => o.total >= r.floor)
  // Component-wise breakdown, matrix cells, non-rebuild strategies only.
  const vecOK = !r.strict || !r.vector || r.ops.slice(1).every((o) =>
    o.added === r.vector.added && o.removed === r.vector.removed &&
    o.attrs === r.vector.attrs && o.text === r.vector.text)
  if (!domOK || !semOK || !cmpOK || !floorOK || !vecOK) failures++
  console.log(
    '  ' + pad(r.scenario, 18) + padn(r.floor, 7) + '  ' + pad(opsStr, 42) +
    ' ' + (domOK ? ' ok ' : 'FAIL') + ' ' + (semOK ? ' ok ' : 'FAIL') +
    ' ' + (r.strict ? (vecOK ? ' ok ' : 'FAIL') : '  — ') +
    '  ' + (r.strict
      ? (cmpOK ? `ok ${r.comparisons}` : `FAIL ${r.comparisons} != ${r.expectedComparisons}`)
      : `— ${r.comparisons}`) +
    (floorOK ? '' : '  FLOOR'),
  )
  if (!domOK) {
    const m = r.domMismatches[0]
    console.log(`       ${r.domMismatches.length} differ from ${r.domRef}, first: ${m.name} @${m.at}`)
    console.log(`         ref: ...${m.expected}...`)
    console.log(`         got: ...${m.actual}...`)
  }
  for (const e of r.semanticErrors.slice(0, 3)) console.log('       SEM ' + e)
}
if (pageErrors.length) {
  failures++
  console.log('\n  PAGE ERRORS:')
  for (const e of pageErrors.slice(0, 10)) console.log('    ' + e)
}
const firstOK = report.rows.find((r) => !r.error)
console.log(`\n  strategy order: ${firstOK ? firstOK.ops.map((o) => o.name).join(' / ') : 'n/a'}`)
console.log(failures === 0
  ? '\n  PASS — identical + semantically correct DOM on both transitions in every\n'
    + '         scenario; matrix cells hit exact floors and breakdowns; the keyed\n'
    + '         diff compared all six mutable fields on every row.\n'
  : `\n  ${failures} FAILING check(s).\n`)

await browser.close()
preview.kill()
process.exit(failures === 0 ? 0 : 1)
