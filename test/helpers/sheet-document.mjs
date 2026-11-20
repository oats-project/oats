// A small document for mounting a Desktop renderer component under plain Node, in a root test (the root
// install has no DOM library; the Desktop's own suite uses jsdom). It models the part of the DOM a sheet
// built from createElement uses: elements and text nodes, attributes, classes, `hidden`, events by name
// with click(), focus and the active element. Nothing is laid out or styled. `textOf(el)` is the visible
// text of an element and its shown descendants, for asserting what a person would read.
class Text {
  constructor(value) { this.nodeType = 3; this.textContent = String(value); }
}
class Element {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag.toUpperCase(); this.nodeType = 1;
    this.childNodes = []; this.attributes = new Map(); this.listeners = new Map(); this.dataset = {};
    this.hidden = false; this.disabled = false; this.className = ""; this.id = ""; this.type = ""; this.title = ""; this.isConnected = false;
    const self = this;
    this.classList = {
      add: (...c) => { self.className = [...new Set([...self.className.split(/\s+/).filter(Boolean), ...c])].join(" "); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(" "); },
      toggle: (c, on) => { const has = self.className.split(/\s+/).includes(c); const want = on === undefined ? !has : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
      contains: (c) => self.className.split(/\s+/).includes(c),
    };
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes = v === "" || v === null || v === undefined ? [] : [new Text(v)]; }
  get lastChild() { return this.childNodes.at(-1) ?? null; }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  append(...nodes) { for (const n of nodes) { const c = typeof n === "string" ? new Text(n) : n; c.parentNode = this; this.childNodes.push(c); } }
  replaceChildren(...nodes) { this.childNodes = []; this.append(...nodes); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn)); }
  dispatch(type, extra = {}) { for (const fn of this.listeners.get(type) || []) fn({ type, target: this, preventDefault() {}, ...extra }); }
  click() { if (!this.disabled) this.dispatch("click"); }
  focus() { this.ownerDocument.activeElement = this; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}
/** → a document: createElement, createElementNS, createTextNode, head, body, activeElement. */
export function sheetDocument() {
  const doc = { activeElement: null };
  doc.createElement = (tag) => new Element(doc, tag);
  doc.createElementNS = (_ns, tag) => new Element(doc, tag);
  doc.createTextNode = (v) => new Text(v);
  doc.head = doc.createElement("head");
  doc.body = doc.createElement("body");
  doc.getElementById = () => null;
  return doc;
}
/** The text a person reads in `el`: its text and its shown children's, each element's on a line. */
export function textOf(el) {
  if (el.nodeType === 3) return el.textContent;
  if (el.hidden) return "";
  const parts = el.childNodes.map(textOf).filter(Boolean);
  return el.childNodes.some((c) => c.nodeType === 1) ? parts.join("\n") : parts.join("");
}
/** Every element under `el` (itself included) whose class list has `cls`. */
export function byClass(el, cls) {
  const out = [];
  const walk = (n) => { if (n.nodeType !== 1) return; if (n.classList.contains(cls)) out.push(n); n.childNodes.forEach(walk); };
  walk(el);
  return out;
}
