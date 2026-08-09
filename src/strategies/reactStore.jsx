import { useSyncExternalStore, useCallback, useLayoutEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'

// The bottom step of the re-render scope staircase.
//
// React's default is top-down: state lives at the root, the root re-renders,
// and every component below it re-runs so React can find the one thing that
// changed. React.memo shortens that walk but does not remove it — the root still
// re-renders and 1000 props comparisons still happen.
//
// This variant removes the walk. Each row subscribes to its own slice of an
// external store, so changing one row notifies exactly one component. The list
// itself only re-renders when the *set of ids* changes.
//
// Notice what building this required: a dependency graph, maintained by hand, so
// that a write can find the readers that care about it. That is what a signals
// runtime (Solid, Svelte 5, Vue) gives you as the default programming model.
// React's escape hatch from its own re-render model converges on the
// architecture that never had the problem.

export function createRowStore(rows) {
  let ids = rows.map((r) => r.id)
  let byId = new Map(rows.map((r) => [r.id, r]))
  const rowListeners = new Map()
  const idListeners = new Set()

  return {
    // getSnapshot must return a stable reference while nothing has changed, or
    // useSyncExternalStore will re-render forever.
    getIds: () => ids,
    getRow: (id) => byId.get(id),
    subscribeIds(cb) {
      idListeners.add(cb)
      return () => idListeners.delete(cb)
    },
    subscribeRow(id, cb) {
      let set = rowListeners.get(id)
      if (!set) {
        set = new Set()
        rowListeners.set(id, set)
      }
      set.add(cb)
      return () => set.delete(cb)
    },
    setRows(next) {
      const nextIds = next.map((r) => r.id)
      const idsChanged =
        nextIds.length !== ids.length || nextIds.some((v, i) => v !== ids[i])

      const nextById = new Map()
      const changed = []
      for (const row of next) {
        nextById.set(row.id, row)
        if (byId.get(row.id) !== row) changed.push(row.id)
      }

      ids = nextIds
      byId = nextById

      if (idsChanged) for (const cb of idListeners) cb()
      for (const id of changed) {
        const set = rowListeners.get(id)
        if (set) for (const cb of set) cb()
      }
    },

    // The targeted write. setRows above still walks all N rows to work out what
    // changed — handing a store a whole new array just relocates the discovery
    // problem into the store. This is what a signals runtime does instead: the
    // write itself names its target, so nothing is ever scanned.
    applyOps(ops) {
      for (const op of ops) {
        if (op.t !== 'text') throw new Error('signal store handles text ops only')
        const prev = byId.get(op.id)
        const next = { ...prev, [op.field]: op.value }
        byId.set(op.id, next)
        const set = rowListeners.get(op.id)
        if (set) for (const cb of set) cb()
      }
    },
  }
}

function StoreRow({ store, id }) {
  const subscribe = useCallback((cb) => store.subscribeRow(id, cb), [store, id])
  const snapshot = useCallback(() => store.getRow(id), [store, id])
  const row = useSyncExternalStore(subscribe, snapshot)
  const Tag = row.tag
  return (
    <div
      className={row.active ? 'row active' : 'row'}
      data-id={row.id}
      data-status={row.status}
    >
      <span className="rid">{row.id}</span>
      <Tag className="label" style={{ color: row.color }}>{row.label}</Tag>
      {row.badge && <span className="badge">new</span>}
    </div>
  )
}

function StoreList({ store, api }) {
  const subscribe = useCallback((cb) => store.subscribeIds(cb), [store])
  const snapshot = useCallback(() => store.getIds(), [store])
  const ids = useSyncExternalStore(subscribe, snapshot)
  useLayoutEffect(() => {
    api.ready = true
  }, [api])
  return ids.map((id) => <StoreRow key={id} store={store} id={id} />)
}

export function createReactStoreStrategy({ targetedWrite = false } = {}) {
  let root = null
  let container = null
  let store = null
  const api = { ready: false }

  return {
    name: targetedWrite
      ? 'react · subscription + targeted write'
      : 'react · per-row subscription',
    kind: 'react',
    note: targetedWrite
      ? 'nothing scans; the write names its row'
      : 'one row re-renders, but the store still walks N',
    mount(el) {
      container = el
      root = createRoot(el)
      store = createRowStore([])
      flushSync(() => root.render(<StoreList store={store} api={api} />))
    },
    reset(state) {
      flushSync(() => store.setRows(state.rows))
    },
    apply(state, ops) {
      if (targetedWrite) flushSync(() => store.applyOps(ops))
      else flushSync(() => store.setRows(state.rows))
    },
    // No marker fiber: the list component does not re-render on a row update,
    // so there is nothing reliable to hang a render-phase timestamp on. Total
    // script time is the honest measurement here.
    marks: () => null,
    unmount() {
      if (root) flushSync(() => root.unmount())
      root = null
      store = null
      container = null
    },
  }
}
