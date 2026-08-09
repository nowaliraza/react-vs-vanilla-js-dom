// Baseline: targeted vanilla JS — the floor.
//
// It is handed the exact semantic change and does nothing but apply it. No
// diffing, no scanning, no bookkeeping beyond an id -> node map. Nothing can
// beat it, which is the point: it turns "theoretical minimum" into a row that
// actually runs and gets timed under the same conditions as everyone else.
//
// Being handed the change is the one artificial thing about it. A React app
// cannot do that — but a signals-based framework effectively can, because the
// dependency was recorded when the value was read. So this is the floor, and it
// is also roughly what a fine-grained-reactive runtime achieves.
//
// The row builder and the single-field writers are exported so the keyed-diff
// baseline performs byte-identical DOM work, and differs only in having to
// *discover* which writes to make.

export function makeBadge() {
  const b = document.createElement('span')
  b.className = 'badge'
  b.appendChild(document.createTextNode('new'))
  return b
}

export function buildRow(row) {
  const el = document.createElement('div')
  el.className = row.active ? 'row active' : 'row'
  el.setAttribute('data-id', row.id)
  el.setAttribute('data-status', row.status)

  const idEl = document.createElement('span')
  idEl.className = 'rid'
  idEl.appendChild(document.createTextNode(String(row.id)))

  const labelEl = document.createElement(row.tag)
  labelEl.className = 'label'
  labelEl.style.setProperty('color', row.color)
  labelEl.appendChild(document.createTextNode(row.label))

  el.appendChild(idEl)
  el.appendChild(labelEl)

  let badgeEl = null
  if (row.badge) {
    badgeEl = makeBadge()
    el.appendChild(badgeEl)
  }

  return {
    el, idEl, labelEl, badgeEl,
    label: row.label, active: row.active, status: row.status,
    color: row.color, badge: row.badge, tag: row.tag,
  }
}

// Writing to `.textContent` would replace the text node: 1 removal + 1
// insertion, two observable ops. Writing `.nodeValue` on the existing text node
// is a single characterData op. React does the latter, so the floor must too or
// it would look artificially expensive.
export function setText(el, value) {
  el.firstChild.nodeValue = value
}

// A tag cannot be mutated in place, so the node is rebuilt and replaced — one
// removal plus one insertion, the same two operations React must perform.
export function replaceTag(ref, tag) {
  const next = document.createElement(tag)
  next.className = 'label'
  next.style.setProperty('color', ref.color)
  next.appendChild(document.createTextNode(ref.label))
  ref.labelEl.replaceWith(next)
  ref.labelEl = next
  ref.tag = tag
}

export function createSurgicalStrategy() {
  let container = null
  let refs = new Map()

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
    name: 'vanilla JS · targeted',
    kind: 'vanilla',
    note: 'applies only the nodes that changed',
    mount(el) {
      container = el
      refs = new Map()
    },
    reset(state) {
      rebuild(state)
    },
    apply(state, ops) {
      for (const op of ops) {
        switch (op.t) {
          case 'appendAll': {
            const frag = document.createDocumentFragment()
            for (const row of op.rows) {
              const r = buildRow(row)
              refs.set(row.id, r)
              frag.appendChild(r.el)
            }
            container.appendChild(frag)
            break
          }
          case 'clear': {
            refs.clear()
            container.replaceChildren()
            break
          }
          case 'text': {
            const r = refs.get(op.id)
            setText(op.field === 'label' ? r.labelEl : r.idEl, op.value)
            r.label = op.value
            break
          }
          case 'attr': {
            const r = refs.get(op.id)
            r.el.setAttribute(op.name, op.value)
            r.status = op.value
            break
          }
          case 'class': {
            const r = refs.get(op.id)
            r.el.classList.toggle('active', op.active)
            r.active = op.active
            break
          }
          case 'style': {
            const r = refs.get(op.id)
            r.labelEl.style.setProperty(op.prop, op.value)
            r.color = op.value
            break
          }
          case 'badge': {
            const r = refs.get(op.id)
            if (op.present) {
              r.badgeEl = makeBadge()
              r.el.appendChild(r.badgeEl)
            } else {
              r.badgeEl.remove()
              r.badgeEl = null
            }
            r.badge = op.present
            break
          }
          case 'tag': {
            replaceTag(refs.get(op.id), op.tag)
            break
          }
          case 'insert': {
            const r = buildRow(op.row)
            refs.set(op.row.id, r)
            container.insertBefore(r.el, op.beforeId ? refs.get(op.beforeId).el : null)
            break
          }
          case 'remove': {
            refs.get(op.id).el.remove()
            refs.delete(op.id)
            break
          }
          case 'swap': {
            const a = refs.get(op.a).el
            const b = refs.get(op.b).el
            const after = b.nextSibling
            container.insertBefore(b, a)
            container.insertBefore(a, after)
            break
          }
          case 'replaceAllInPlace': {
            // Same node count, same shape — so keep every element and rewrite
            // the fields that differ. This is what a keyed diff *cannot* do,
            // because all the keys changed.
            let node = container.firstChild
            const nextRefs = new Map()
            for (const row of op.rows) {
              const idEl = node.firstChild
              const labelEl = idEl.nextSibling
              setText(idEl, String(row.id))
              setText(labelEl, row.label)
              node.setAttribute('data-id', row.id)
              nextRefs.set(row.id, {
                el: node, idEl, labelEl,
                badgeEl: node.querySelector('.badge'),
                label: row.label, active: row.active, status: row.status,
                color: row.color, badge: row.badge, tag: row.tag,
              })
              node = node.nextSibling
            }
            refs = nextRefs
            break
          }
          default:
            throw new Error('unknown op ' + op.t)
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
