import { useState } from 'react'

// Why this panel exists.
//
// The benchmark says index keys are *faster* on a swap: 6 DOM operations versus
// 1994. That number is real. Taken alone it invites exactly the wrong
// conclusion, because performance was never the reason keys exist.
//
// Keys tell React which row is which. Uncontrolled DOM state — what the user
// typed, focus, scroll position, text selection, media playback — lives on the
// DOM node, not in your data. With index keys, React keeps the node where it is
// and rewrites its contents, so that state stays behind with the *position*
// while the data moves on without it.
//
// This is not a benchmark. It is the demonstration the numbers need next to
// them, and you have to type in it for the point to land.

const START = [
  { id: 'a', label: 'Row A' },
  { id: 'b', label: 'Row B' },
  { id: 'c', label: 'Row C' },
  { id: 'd', label: 'Row D' },
]

function DemoList({ rows, keyed }) {
  return (
    <div className="demo-list">
      {rows.map((row, i) => (
        <label className="demo-row" key={keyed ? row.id : i}>
          <span className="demo-label">{row.label}</span>
          {/* Uncontrolled on purpose: its value lives in the DOM node, which is
              precisely the thing keys decide the fate of. */}
          <input type="text" placeholder="type here…" defaultValue="" />
        </label>
      ))}
    </div>
  )
}

export function KeysDemo() {
  const [rows, setRows] = useState(START)

  const shuffle = () => {
    const next = rows.slice()
    next.reverse()
    setRows(next)
  }
  const swapTwo = () => {
    const next = rows.slice()
    const t = next[0]
    next[0] = next[3]
    next[3] = t
    setRows(next)
  }

  return (
    <section className="result">
      <header>
        <h3>Why keys exist — and why the swap numbers mislead</h3>
        <p className="desc">
          The benchmark shows <code>key=&#123;index&#125;</code> doing a swap in 6
          DOM operations where <code>key=&#123;row.id&#125;</code> takes 1994.
          That is true, and it is not a reason to use index keys. Type something
          into the inputs on both sides, then reorder.
        </p>
      </header>

      <div className="demo-actions">
        <button onClick={swapTwo}>Swap first and last</button>
        <button onClick={shuffle}>Reverse order</button>
        <button onClick={() => setRows(START)}>Reset</button>
      </div>

      <div className="demo-grid">
        <div>
          <h4 className="demo-title good">key=&#123;row.id&#125;</h4>
          <p className="demo-note">
            What you typed follows its row. Identity belongs to the data.
          </p>
          <DemoList rows={rows} keyed />
        </div>
        <div>
          <h4 className="demo-title bad">key=&#123;index&#125;</h4>
          <p className="demo-note">
            What you typed stays put while the labels move past it. Identity
            belongs to the position.
          </p>
          <DemoList rows={rows} keyed={false} />
        </div>
      </div>

      <p className="demo-conclusion">
        Both sides render the same labels in the same order, so a screenshot
        cannot tell them apart — and neither can an operation count. The
        right-hand list is fewer operations and wrong. Speed is not the axis keys
        are on: they decide whether React preserves a row's DOM node, and
        anything the browser stored on that node rides along with the decision.
      </p>
    </section>
  )
}
