// Baseline #1: the way most hand-written DOM code actually gets written.
// Throw a string at the parser and let it rebuild the world.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESCAPES[c])

function toHTML(state) {
  let out = ''
  for (const r of state.rows) {
    out +=
      '<div class="row' + (r.active ? ' active' : '') +
      '" data-id="' + r.id + '" data-status="' + r.status + '">' +
      '<span class="rid">' + r.id + '</span>' +
      // Serialisation must match what style.setProperty produces, or the DOM
      // is not byte-identical to the other strategies and the premise breaks.
      '<' + r.tag + ' class="label" style="color: ' + r.color + ';">' +
      esc(r.label) + '</' + r.tag + '>' +
      (r.badge ? '<span class="badge">new</span>' : '') +
      '</div>'
  }
  return out
}

export function createInnerHTMLStrategy() {
  let container = null
  return {
    name: 'vanilla JS · rebuild',
    kind: 'vanilla',
    note: 'rebuild the markup string, hand it to the parser',
    mount(el) {
      container = el
    },
    reset(state) {
      container.innerHTML = toHTML(state)
    },
    apply(state) {
      container.innerHTML = toHTML(state)
    },
    marks: () => null,
    unmount() {
      if (container) container.innerHTML = ''
      container = null
    },
  }
}
