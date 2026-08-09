import { makeRows } from './data.js'

// Every scenario is built once per run, so all four strategies see byte-identical
// before/after state and the op counts are reproducible.
//
// `base` -> `next` is the state transition. `ops` is the same transition
// expressed as the minimum sequence of imperative DOM operations, which the
// targeted vanilla JS strategy replays. That's what makes the floor column real
// rather than hypothetical: it isn't an estimate, it's a strategy that actually
// runs and gets timed like the others.
//
// `minOps` is the analytic lower bound on observable MutationObserver
// operations. Note that a "move" is remove + insert to the observer, so each
// repositioned node costs 2.

// Spread, never a hand-listed subset: a row carries every field the mutation
// matrix can change, and rebuilding it field-by-field silently drops the rest.
const bump = (row) => ({ ...row, label: row.label + ' !!!' })

// Spread `count` changes evenly across the list rather than clustering them at
// the head — clustered changes flatter any diff that bails out early.
function spreadIndices(n, count) {
  const idx = []
  const stride = n / count
  // Midpoint of each interval, not its start: with `i * stride` the single-row
  // case degenerated to index 0 while the docs said "middle of the list".
  for (let i = 0; i < count; i++) idx.push(Math.min(n - 1, Math.floor((i + 0.5) * stride)))
  return idx
}

function updateScenario(id, label, desc, countFor) {
  return {
    id,
    label,
    desc,
    minDesc: 'one text-node write per changed row',
    build(n) {
      const rows = makeRows(n)
      const count = Math.max(1, Math.min(n, countFor(n)))
      const idx = spreadIndices(n, count)
      const next = rows.slice()
      const ops = []
      for (const i of idx) {
        // New object identity for changed rows only — this is what lets
        // React.memo bail out on the untouched ones.
        next[i] = bump(rows[i])
        ops.push({ t: 'text', id: rows[i].id, field: 'label', value: next[i].label })
      }
      return {
        base: { rows, selected: null },
        next: { rows: next, selected: null },
        ops,
        minOps: count,
        changed: count,
      }
    },
  }
}

export const SCENARIOS = [
  {
    id: 'create',
    label: 'Create N rows',
    desc: 'Mount the whole list from an empty container.',
    minDesc: 'N row nodes appended in one batch (children built detached)',
    build(n) {
      const rows = makeRows(n)
      return {
        base: { rows: [], selected: null },
        next: { rows, selected: null },
        ops: [{ t: 'appendAll', rows }],
        minOps: n,
        changed: n,
      }
    },
  },

  {
    id: 'noop',
    label: 'Re-render, nothing changed',
    desc: 'Every row object is new, every value is identical. The purest measurement of the virtual DOM tax: full render, full diff, zero DOM work.',
    minDesc: 'nothing needs to happen',
    build(n) {
      const rows = makeRows(n)
      return {
        base: { rows, selected: null },
        // New object identity for every row, same values. React cannot bail out
        // on identity, so it renders and reconciles all N — and then finds
        // nothing to do. React.memo does not help here either: its shallow
        // compare fails on the fresh objects.
        //
        // Spread, not a hand-listed subset. An earlier version rebuilt these as
        // { id, label } and silently dropped every field the mutation matrix
        // added, which made the keyed diff read badge:false -> undefined as a
        // removal and crash on a null node.
        next: { rows: rows.map((r) => ({ ...r })), selected: null },
        ops: [],
        minOps: 0,
        changed: 0,
      }
    },
  },

  updateScenario(
    'update1',
    'Update 1 row',
    'Change one label in the middle of the list. The canonical "why do I need a diff" case.',
    () => 1,
  ),

  updateScenario(
    'update10th',
    'Update every 10th row',
    'The js-framework-benchmark partial-update case.',
    (n) => Math.ceil(n / 10),
  ),

  {
    id: 'swap',
    label: 'Swap 2 rows',
    desc: 'Swap row 1 and row N-2. The scenario where key choice stops being cosmetic.',
    minDesc: '2 moves = 2 removes + 2 inserts',
    build(n) {
      const rows = makeRows(n)
      const a = 1
      const b = Math.max(2, n - 2)
      const next = rows.slice()
      next[a] = rows[b]
      next[b] = rows[a]
      return {
        base: { rows, selected: null },
        next: { rows: next, selected: null },
        ops: [{ t: 'swap', a: rows[a].id, b: rows[b].id }],
        minOps: 4,
        changed: 2,
      }
    },
  },

  {
    id: 'insertHead',
    label: 'Insert at head',
    desc: 'Prepend one row. Every subsequent index shifts by one.',
    minDesc: '1 node inserted',
    build(n) {
      const rows = makeRows(n)
      const [extra] = makeRows(1, 3)
      return {
        base: { rows, selected: null },
        next: { rows: [extra, ...rows], selected: null },
        ops: [{ t: 'insert', row: extra, beforeId: rows[0].id }],
        minOps: 1,
        changed: 1,
      }
    },
  },

  {
    id: 'removeOne',
    label: 'Remove 1 row',
    desc: 'Delete row index 1.',
    minDesc: '1 node removed',
    build(n) {
      const rows = makeRows(n)
      const victim = rows[1]
      return {
        base: { rows, selected: null },
        next: { rows: rows.filter((r) => r.id !== victim.id), selected: null },
        ops: [{ t: 'remove', id: victim.id }],
        minOps: 1,
        changed: 1,
      }
    },
  },

  {
    id: 'replaceAll',
    label: 'Replace all rows',
    desc: 'Entirely new data, new ids. Nothing is reusable by key.',
    minDesc: 'replace each row node: N removals + N insertions',
    build(n) {
      const rows = makeRows(n)
      // Seed 2, not the default. With the same seed the label sequence repeats
      // and "entirely new data" is false: every label would be written back to
      // its own value, which flatters strategies that rewrite text in place and
      // penalises nothing.
      const fresh = makeRows(n, 2)
      return {
        base: { rows, selected: null },
        next: { rows: fresh, selected: null },
        ops: [{ t: 'replaceAllInPlace', rows: fresh }],
        // 2N, not 3N. Rewriting a row in place costs 3 ops (id text, label text,
        // data-id attribute); throwing the node away and building a new one
        // costs 2 (one removal, one insertion). The cheaper option sets the
        // floor. An earlier version of this file declared 3N and was then
        // "beaten" by two strategies at 2N — a floor that gets beaten is a bug,
        // not a finding.
        //
        // Worth noting that targeted vanilla JS deliberately takes the 3N route
        // here and is still the fastest of the four. More operations, less time:
        // text writes are cheap, building and destroying nodes is not.
        minOps: 2 * n,
        changed: n,
      }
    },
  },

]


// ── Mutation-kind matrix ────────────────────────────────────────────────────
// Everything above varies *how much* changed. This varies *what kind* of change
// is required, which is the axis on which React's cost stops being uniform.
//
// Each kind runs at two densities — one row and every row — against the same
// list, the same data and the same CSS. Only the field being changed differs
// between base and next.
//
// Event handlers are deliberately absent. Swapping a handler produces no
// observable change to the document, so it is not a DOM update at all; it is a
// question about how each system stores callbacks. It is also invisible to a
// MutationObserver and would need separate instrumentation.
//
// Metric boundary, which matters most for the style kind: `script` plus forced
// layout captures reconciliation and style recalculation. It does NOT isolate
// paint. Read the style rows as "style reconciliation plus style recalculation,
// excluding isolated paint cost".

const KINDS = {
  text: {
    vec: { text: 1 },
    label: 'Text',
    desc: 'Rewrite one text node per changed row. The baseline every other kind is measured against.',
    minDesc: 'one text-node write per changed row',
    minPerRow: 1,
    change: (r) => ({ ...r, label: r.label + ' !!!' }),
    op: (r, next) => ({ t: 'text', id: r.id, field: 'label', value: next.label }),
  },

  attribute: {
    vec: { attrs: 1 },
    label: 'Attribute',
    desc: 'Flip data-status — React’s generic attribute path, reached by any prop it does not special-case.',
    minDesc: 'one attribute write per changed row',
    minPerRow: 1,
    change: (r) => ({ ...r, status: r.status === 'ready' ? 'busy' : 'ready' }),
    op: (r, next) => ({ t: 'attr', id: r.id, name: 'data-status', value: next.status }),
  },

  className: {
    vec: { attrs: 1 },
    label: 'Class',
    desc: 'Toggle a class. React special-cases the prop name and calls setValueForKnownAttribute(el, "class", v) — a known-attribute path with name mapping, not a DOM property write. Distinct from the generic path above, though both end in one attribute mutation, so a null result is the expected outcome.',
    minDesc: 'one class attribute write per changed row',
    minPerRow: 1,
    change: (r) => ({ ...r, active: !r.active }),
    op: (r, next) => ({ t: 'class', id: r.id, active: next.active }),
  },

  style: {
    vec: { attrs: 1 },
    label: 'Style',
    desc: 'Change exactly one property of a freshly allocated style object. Fresh object because that is what JSX produces every render; one changed property because that is what separates React’s per-property style diff from the cost of the write. The property is `color` — a real paint consumer, so the browser cannot legitimately skip the work.',
    minDesc: 'one style attribute write per changed row',
    minPerRow: 1,
    change: (r) => ({
      ...r,
      color: r.color === 'rgb(139, 149, 165)' ? 'rgb(224, 160, 58)' : 'rgb(139, 149, 165)',
    }),
    op: (r, next) => ({ t: 'style', id: r.id, prop: 'color', value: next.color }),
  },

  badgeAdd: {
    vec: { added: 1 },
    label: 'Conditional child — add',
    desc: 'A child element appears. Identical live mutation for everyone; React additionally constructs a fiber.',
    minDesc: 'one node inserted per changed row',
    minPerRow: 1,
    baseRow: (r) => ({ ...r, badge: false }),
    change: (r) => ({ ...r, badge: true }),
    op: (r) => ({ t: 'badge', id: r.id, present: true }),
  },

  badgeRemove: {
    vec: { removed: 1 },
    label: 'Conditional child — remove',
    desc: 'The same child disappears. Split from the add case because React’s deletion path differs from its construction path — though with no effects mounted on the child, the difference is fiber deletion bookkeeping alone and may be too small to resolve. No useEffect is added to make it look bigger: that would change the axis from mutation kind to component lifecycle.',
    minDesc: 'one node removed per changed row',
    minPerRow: 1,
    baseRow: (r) => ({ ...r, badge: true }),
    change: (r) => ({ ...r, badge: false }),
    op: (r) => ({ t: 'badge', id: r.id, present: false }),
  },

  type: {
    vec: { added: 1, removed: 1 },
    label: 'Element type',
    desc: 'The label element changes tag. No DOM API can mutate a tag in place, so both sides must replace the node — but React must additionally discard and rebuild the fiber subtree. The stress case of the matrix.',
    minDesc: 'one removal + one insertion per changed row',
    minPerRow: 2,
    change: (r) => ({ ...r, tag: r.tag === 'span' ? 'i' : 'span' }),
    op: (r, next) => ({ t: 'tag', id: r.id, tag: next.tag }),
  },
}

function mutationScenario(key, dense) {
  const k = KINDS[key]
  return {
    id: `${key}-${dense ? 'all' : 'one'}`,
    label: `${k.label} — ${dense ? 'every row' : '1 row'}`,
    desc: k.desc,
    minDesc: k.minDesc,
    kind: key,
    dense,
    build(n) {
      const rows = makeRows(n).map(k.baseRow || ((r) => r))
      const idx = dense ? rows.map((_, i) => i) : [Math.floor(n / 2)]
      const next = rows.slice()
      const ops = []
      for (const i of idx) {
        next[i] = k.change(rows[i])
        ops.push(k.op(rows[i], next[i]))
      }
      return {
        base: { rows, selected: null },
        next: { rows: next, selected: null },
        ops,
        minOps: idx.length * k.minPerRow,
        // Expected MutationObserver breakdown, per component. Two wrong mutation
        // patterns can share a total; the gate asserts each component.
        vector: {
          added: (k.vec.added || 0) * idx.length,
          removed: (k.vec.removed || 0) * idx.length,
          attrs: (k.vec.attrs || 0) * idx.length,
          text: (k.vec.text || 0) * idx.length,
        },
        changed: idx.length,
      }
    },
  }
}

export const MUTATION_KINDS = Object.keys(KINDS)

// 7 kinds x 2 densities = 14 cells.
export const MATRIX = MUTATION_KINDS.flatMap((k) => [
  mutationScenario(k, false),
  mutationScenario(k, true),
])

// Used by the density sweep: same shape as a scenario, parameterised by the
// fraction of rows that change.
export function densityScenario(fraction) {
  return updateScenario(
    `density-${fraction}`,
    `Update ${(fraction * 100).toFixed(1)}% of rows`,
    'Density sweep sample.',
    (n) => Math.max(1, Math.round(n * fraction)),
  )
}
