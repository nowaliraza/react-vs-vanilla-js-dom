import { useState, useLayoutEffect, memo, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

// The subject under dissection.
//
// Two knobs, both of which are the point of the experiment:
//   keyed    — key={row.id} vs key={index}. One character, orders of magnitude.
//   memoized — React.memo on the row, so unchanged rows bail out of render.
//
// ── How the render/commit split is obtained ──────────────────────────────────
// Not with <Profiler>. Measured on this workload, wrapping the tree in a
// Profiler inflates a 3ms update to 32ms, because it timestamps every fiber
// through beginWork/completeWork — roughly 8000 performance.now() calls for a
// 1000-row list. Deriving commit as (total − actualDuration) then charges all of
// that instrumentation to the commit phase and reports a fiction.
//
// Instead: one <Marker/> fiber, last in the list.
//   · its function body runs during the render phase, after every row
//   · its layout effect runs during commit, after the mutation phase
// Two performance.now() calls per update instead of eight thousand.
//
// The boundary is approximate — completeWork for ancestors lands on the commit
// side of the line — but the error is a couple of fibers, not a couple of
// thousand, and it does not scale with N.

let renderMark = 0
let commitMark = 0

function Marker() {
  // Side effect during render. Legitimate here: one root, no StrictMode, no
  // concurrent rendering — every render of this fiber is committed.
  renderMark = performance.now()
  useLayoutEffect(() => {
    commitMark = performance.now()
  })
  return null
}

function RowBase({ row }) {
  // `Tag` is a variable so the element-type scenario can swap span <-> i.
  // React compares the type string; a mismatch means the old fiber and its DOM
  // node are discarded and rebuilt, which is the whole point of that cell.
  const Tag = row.tag
  return (
    <div
      className={row.active ? 'row active' : 'row'}
      data-id={row.id}
      data-status={row.status}
    >
      <span className="rid">{row.id}</span>
      {/* A fresh style object every render — exactly what JSX produces in real
          code, and the only version that actually exercises React's
          per-property style diff. */}
      <Tag className="label" style={{ color: row.color }}>{row.label}</Tag>
      {row.badge && <span className="badge">new</span>}
    </div>
  )
}
const RowMemo = memo(RowBase)

function List({ state, keyed, memoized }) {
  const Row = memoized ? RowMemo : RowBase
  const children = state.rows.map((row, i) => (
    <Row key={keyed ? row.id : i} row={row} />
  ))
  // Renders to null, so the committed DOM stays byte-identical to the other
  // strategies and the op counts are unaffected.
  children.push(<Marker key="__marker" />)
  return children
}

function Bench({ initial, keyed, memoized, api }) {
  const [state, setState] = useState(initial)
  useLayoutEffect(() => {
    api.setState = setState
  }, [api])
  return <List state={state} keyed={keyed} memoized={memoized} />
}

export function createReactStrategy({ keyed, memoized, profiled = false, name }) {
  let root = null
  let container = null
  const api = { setState: null }
  let profilerRender = null

  const onRender = (_id, _phase, actualDuration) => {
    profilerRender = actualDuration
  }

  function tree(initial) {
    const bench = (
      <Bench initial={initial} keyed={keyed} memoized={memoized} api={api} />
    )
    // Opt-in cross-check only. Turning this on distorts the total it is
    // supposedly explaining; see the note above.
    return profiled ? (
      <Profiler id="bench" onRender={onRender}>{bench}</Profiler>
    ) : bench
  }

  return {
    name: name || `react · ${keyed ? 'key={row.id}' : 'key={index}'}`,
    kind: 'react',
    keyed,
    note: name
      ? (memoized ? 'root re-renders; memo bails out the rest' : 'root re-renders; every row re-runs')
      : (keyed ? 'stable identity per row' : 'identity follows position'),
    mount(el) {
      container = el
      root = createRoot(el)
      // flushSync so the mount completes (and api.setState is assigned) before
      // anything is measured. React 18+ schedules by default; without this the
      // timer would close around a call that has not done the work yet.
      flushSync(() => root.render(tree({ rows: [], selected: null })))
    },
    reset(state) {
      flushSync(() => api.setState(state))
    },
    apply(state) {
      renderMark = 0
      commitMark = 0
      profilerRender = null
      flushSync(() => api.setState(state))
    },
    marks: () => ({ renderMark, commitMark, profilerRender }),
    unmount() {
      if (root) flushSync(() => root.unmount())
      root = null
      api.setState = null
      container = null
    },
  }
}
