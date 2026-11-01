// Minimal DOM double for overlay interaction tests. It models the browser
// behavior important here: moving existing nodes reparents them, replacing
// focused descendants loses focus, disabled buttons do not click, and events
// bubble. Canvas drawing is verified separately by render tests/browser checks.

class TestNode {
  constructor(ownerDocument, tagName = "", text = "") {
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.nodeType = tagName ? 1 : 3;
    this.parentNode = null;
    this.childNodes = [];
    this.attributes = new Map();
    this.listeners = new Map();
    this._text = text;
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.style = { setProperty() {} };
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (...names) => {
        this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(" ");
      },
      remove: (...names) => {
        this.className = this.className.split(/\s+/).filter((name) => name && !names.includes(name)).join(" ");
      },
      toggle: (name, force) => {
        const add = force === undefined ? !this.classList.contains(name) : force;
        if (add) this.classList.add(name);
        else this.classList.remove(name);
        return add;
      },
    };
    this.dataset = new Proxy({}, {
      get: (_, key) => this.getAttribute("data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())),
      set: (_, key, value) => {
        this.setAttribute("data-" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), value);
        return true;
      },
    });
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get parentElement() { return this.parentNode; }
  get className() { return this.attributes.get("class") || ""; }
  set className(value) { this.attributes.set("class", String(value)); }
  get id() { return this.attributes.get("id") || ""; }
  set id(value) { this.attributes.set("id", String(value)); }
  get isConnected() { return this.ownerDocument.body.contains(this); }
  get textContent() {
    return this._text + this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value) {
    for (const child of [...this.childNodes]) this.removeChild(child);
    this._text = String(value ?? "");
  }
  set innerHTML(value) {
    if (value) throw new Error("The overlay test DOM deliberately does not parse HTML.");
    this.textContent = "";
  }
  get innerHTML() { return this.textContent; }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "hidden") this.hidden = true;
    if (name === "disabled") this.disabled = true;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "hidden") this.hidden = false;
    if (name === "disabled") this.disabled = false;
  }
  toggleAttribute(name, force) {
    const add = force === undefined ? !this.hasAttribute(name) : force;
    if (add) this.setAttribute(name, "");
    else this.removeAttribute(name);
    return add;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    this.childNodes.push(child);
    child.parentNode = this;
    return child;
  }
  append(...children) {
    for (const child of children) this.appendChild(typeof child === "string" ? this.ownerDocument.createTextNode(child) : child);
  }
  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index < 0) throw new Error("Not a child");
    if (child.contains(this.ownerDocument.activeElement)) this.ownerDocument.activeElement = this.ownerDocument.body;
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  replaceChildren(...children) {
    this.textContent = "";
    this.append(...children);
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  getContext() { return null; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 320, height: 320 }; }
  scrollIntoView() {}

  matches(selector) {
    return selector.split(",").some((part) => matchesChain(this, part.trim()));
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.childNodes) {
      if (child.nodeType === 1 && child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    event.stopPropagation ||= function () { this.stopped = true; };
    event.preventDefault ||= function () { this.defaultPrevented = true; };
    for (const fn of this.listeners.get(event.type) || []) fn(event);
    if (!event.stopped && event.bubbles !== false && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() {
    if (this.disabled) return;
    this.dispatchEvent({ type: "click", bubbles: true, target: this });
  }
}

function matchesSimple(node, selector) {
  selector = selector.trim();
  if (!selector) return false;
  for (const match of selector.matchAll(/:not\(([^)]+)\)/g)) {
    if (matchesSimple(node, match[1])) return false;
  }
  selector = selector.replace(/:not\([^)]+\)/g, "");
  if (selector.includes(":disabled") && !node.disabled) return false;
  selector = selector.replace(/:disabled/g, "");
  const tag = selector.match(/^[a-zA-Z][\w-]*/);
  if (tag && node.tagName !== tag[0].toUpperCase()) return false;
  for (const match of selector.matchAll(/#([\w-]+)/g)) if (node.id !== match[1]) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(match[1])) return false;
  for (const match of selector.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)) {
    const actual = match[1] === "hidden" ? (node.hidden ? "" : null) : node.getAttribute(match[1]);
    if (actual === null || (match[2] !== undefined && actual !== match[2])) return false;
  }
  return true;
}

function matchesChain(node, selector) {
  const parts = selector.split(/\s+/);
  if (!matchesSimple(node, parts.pop())) return false;
  let parent = node.parentNode;
  while (parts.length) {
    const part = parts.pop();
    while (parent && !matchesSimple(parent, part)) parent = parent.parentNode;
    if (!parent) return false;
    parent = parent.parentNode;
  }
  return true;
}

export function createTestDocument() {
  const document = {
    createElement: (tag) => new TestNode(document, tag),
    createTextNode: (text) => new TestNode(document, "", text),
    querySelector: (selector) => document.body.querySelector(selector),
    querySelectorAll: (selector) => document.body.querySelectorAll(selector),
    getElementById: (id) => document.body.querySelector("#" + id),
  };
  document.body = new TestNode(document, "body");
  document.activeElement = document.body;
  return document;
}

export function isVisible(node) {
  for (let current = node; current; current = current.parentNode) if (current.hidden) return false;
  return node.isConnected;
}
