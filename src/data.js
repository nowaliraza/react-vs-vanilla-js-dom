// Deterministic data so two runs are comparable and op counts are stable.
function lcg(seed) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

const ADJECTIVES = [
  'pretty', 'large', 'big', 'small', 'tall', 'short', 'long', 'handsome',
  'plain', 'quaint', 'clean', 'elegant', 'easy', 'angry', 'crazy', 'helpful',
  'mushy', 'odd', 'unsightly', 'adorable', 'important', 'inexpensive',
  'cheap', 'expensive', 'fancy',
]
const COLOURS = [
  'red', 'yellow', 'blue', 'green', 'pink', 'brown', 'purple', 'white',
  'black', 'orange',
]
const NOUNS = [
  'table', 'chair', 'house', 'bbq', 'desk', 'car', 'pizza', 'mouse',
  'keyboard', 'lamp',
]

// Ids are derived from the seed rather than a module-global counter, so a run
// is byte-identical to the one before it. Distinct seeds also guarantee distinct
// id ranges, which is what lets a scenario build two non-overlapping datasets.
export function makeRows(n, seed = 1) {
  const rnd = lcg(seed)
  let idCounter = seed * 1000000 + 1
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const label =
      ADJECTIVES[(rnd() * ADJECTIVES.length) | 0] + ' ' +
      COLOURS[(rnd() * COLOURS.length) | 0] + ' ' +
      NOUNS[(rnd() * NOUNS.length) | 0]
    // Every field the mutation-kind matrix can change. Defaults are the "base"
    // state; each scenario flips exactly one of them.
    out[i] = {
      id: idCounter++,
      label,
      active: false,          // className
      status: 'ready',        // data-status attribute
      color: 'rgb(139, 149, 165)', // one inline style property, a real paint consumer
      badge: false,           // conditional child
      tag: 'span',            // element type of the label node
    }
  }
  return out
}
