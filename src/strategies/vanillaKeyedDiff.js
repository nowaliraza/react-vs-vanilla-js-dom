import { buildRow, makeBadge, setText, replaceTag } from './vanillaSurgical.js'

// Baseline: the fair comparison.
//
// The other two vanilla strategies sit at the extremes. `rebuild` doesn't try to
// work out what changed. `targeted` isn't allowed to try — it is handed the
// answer. Neither is what a competent developer actually writes.
//
// This one receives **exactly what React receives**: the next state array,
// nothing else. It has to discover the changes itself, the same job React's
// reconciler does, with the same information, using an id -> node map and a
// single-pass keyed walk.
//
// That makes it the apples-to-apples row. The gap between this and React is not
// "the cost of the virtual DOM" — both are reconciling. It is the cost of
// React's *component model* on top of reconciliation: running component
// functions, allocating element objects, maintaining fibers.
//
// ── Why the comparison counter exists ───────────────────────────────────────
// This strategy is the easiest place in the project to accidentally cheat. If it
// forgets to *check* a field, it does less discovery work, still produces the
// correct DOM, still lands on the mutation floor — and looks faster than React
// for a reason that is an omission rather than a result.
//
// Matching op counts does not rule that out: op counts prove the same live
// mutations were produced, not that the same state was inspected. So the
// comparisons are countable, and `scripts/verify-fairness.js` asserts that this
// strategy inspects every field React compares, on every row. The counter is
// opt-in and off during timing runs.

// The six mutable fields of the experiment's row contract. `id` is identity —
// it is the key, never a compared value. The gate asserts this list matches the
// row schema, so a new field cannot be added without being compared here.
export const COMPARED_FIELDS = ['label', 'active', 'status', 'color', 'badge', 'tag']

export function createKeyedDiffStrategy({ instrument = false } = {}) {
  let container = null
  let refs = new Map()
  let comparisons = 0

  function rebuild(state) {
    refs = new Map()
    const frag = document.createDocumentFragment()
    for (const row of state.rows) {
      const r = buildRow(row)
      refs.set(row.id, r)
      frag.appendChild(r.el)
    }
    container.replaceChildren(frag)
  }

  return {
    name: 'vanilla JS · keyed diff',
    kind: 'vanilla',
    note: 'same input as React; works out the changes itself',
    comparisons: () => comparisons,
    resetComparisons() {
      comparisons = 0
    },
    mount(el) {
      container = el
      refs = new Map()
    },
    reset(state) {
      rebuild(state)
    },
    apply(state) {
      const next = state.rows

      // Mounting into an empty container: build the subtree detached and attach
      // it once. React does the same on initial mount, so doing otherwise would
      // penalise this strategy for something unrelated to diffing.
      if (refs.size === 0 && next.length > 0) {
        rebuild(state)
        return
      }

      // 1. Anything whose key is gone from the new data gets removed.
      const nextIds = new Set()
      for (const row of next) nextIds.add(row.id)
      for (const [id, ref] of refs) {
        if (!nextIds.has(id)) {
          ref.el.remove()
          refs.delete(id)
        }
      }

      // 2. Walk the new order with a cursor on the node expected next. Matches
      //    advance the cursor; mismatches get moved into place. Deliberately the
      //    straightforward single-pass algorithm — the same shape React uses,
      //    with the same blind spot (see the swap scenario, where both move ~N
      //    nodes to achieve a 2-node exchange).
      let cursor = container.firstChild
      for (const row of next) {
        let ref = refs.get(row.id)
        if (!ref) {
          ref = buildRow(row)
          refs.set(row.id, ref)
          container.insertBefore(ref.el, cursor)
          continue
        }
        if (ref.el !== cursor) {
          container.insertBefore(ref.el, cursor)
        } else {
          cursor = cursor.nextSibling
        }

        // 3. Compare each of the six mutable fields, write only what differs.
        //    The counter increments at each actual comparison — a constant
        //    `+= 6` would keep passing after a comparison was deleted.
        if (instrument) comparisons++
        const tagChanged = ref.tag !== row.tag
        if (instrument) comparisons++
        if (ref.label !== row.label) {
          if (!tagChanged) setText(ref.labelEl, row.label)
          ref.label = row.label
        }
        if (instrument) comparisons++
        if (ref.color !== row.color) {
          if (!tagChanged) ref.labelEl.style.setProperty('color', row.color)
          ref.color = row.color
        }
        // replaceTag rebuilds the node from the ref's (now updated) values.
        if (tagChanged) replaceTag(ref, row.tag)
        if (instrument) comparisons++
        if (ref.active !== row.active) {
          ref.el.classList.toggle('active', row.active)
          ref.active = row.active
        }
        if (instrument) comparisons++
        if (ref.status !== row.status) {
          ref.el.setAttribute('data-status', row.status)
          ref.status = row.status
        }
        if (instrument) comparisons++
        if (ref.badge !== row.badge) {
          if (row.badge) {
            ref.badgeEl = makeBadge()
            ref.el.appendChild(ref.badgeEl)
          } else {
            ref.badgeEl.remove()
            ref.badgeEl = null
          }
          ref.badge = row.badge
        }
      }
    },
    marks: () => null,
    unmount() {
      if (container) container.replaceChildren()
      refs = new Map()
      container = null
    },
  }
}
