// Op counting is the deterministic half of this experiment. Timing needs warmup,
// medians and p95 because it drifts; a MutationObserver record count is an
// integer that comes out identical every run.
//
// One honest caveat, worth understanding before reading any result: the observer
// only sees mutations to nodes *already in the observed tree*. If a strategy
// builds a subtree detached and appends it in one shot, the internal
// appendChilds are invisible and you see a single insert. That is not a
// measurement bug — it is exactly the optimisation, and it is why React's
// "create 1000 rows" op count is far below 1000.
export function createOpCounter() {
  let obs = null

  return {
    attach(el) {
      obs = new MutationObserver(() => {})
      obs.observe(el, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      })
    },
    // Throw away anything queued by untimed setup work.
    drain() {
      if (obs) obs.takeRecords()
    },
    take() {
      const recs = obs ? obs.takeRecords() : []
      let added = 0, removed = 0, attrs = 0, text = 0
      for (const r of recs) {
        if (r.type === 'childList') {
          added += r.addedNodes.length
          removed += r.removedNodes.length
        } else if (r.type === 'attributes') {
          attrs++
        } else {
          text++
        }
      }
      return {
        records: recs.length,
        added, removed, attrs, text,
        total: added + removed + attrs + text,
      }
    },
    detach() {
      if (obs) obs.disconnect()
      obs = null
    },
  }
}

function quantile(sorted, q) {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

export function summarize(samples) {
  const s = samples.slice().sort((a, b) => a - b)
  return {
    p50: quantile(s, 0.5),
    p95: quantile(s, 0.95),
    min: s[0] ?? 0,
    // Carried through so the UI can say how much evidence a number rests on,
    // and warn when that is too little.
    n: s.length,
  }
}

// Reading offsetHeight forces the browser to flush style + layout synchronously,
// which is the only way to pull that cost inside a timer. Without it you are
// timing script only and the layout bill arrives after your measurement ends.
export function forceLayout(el) {
  return el.offsetHeight
}

export const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

// rAF fires before paint; a task queued from inside it runs after the frame has
// been presented. That pair is the closest a page can get to "the user saw it".
export const afterPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
