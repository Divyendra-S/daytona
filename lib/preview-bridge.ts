/** Where the preview proxy serves the bridge, on the preview's own origin. */
export const BRIDGE_PATH = "/__adorable/bridge.js";

/**
 * Runs inside the live preview — served and injected by the preview proxy (`lib/preview-proxy.ts`).
 *
 * The preview is another origin, so Adorable cannot reach into it; this script is the other end
 * of a postMessage channel. Picking follows the canvas app's element picker: the element under
 * the event rather than a hit test, a capture-phase click (and press) so the app's own handlers
 * never fire, Escape to stop, a hover ring and a picked ring kept in place on scroll. It also
 * reports where the page is and goes back/forward on request, because the parent cannot read or
 * drive a cross-origin frame's history.
 *
 * Plain ES2017 with no template placeholders: it is shipped as a string.
 */
export const BRIDGE_SCRIPT = String.raw`(() => {
  if (window.__adorableBridge || window.parent === window) return;
  window.__adorableBridge = true;

  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || "*";
  const post = (message) =>
    window.parent.postMessage(Object.assign({ source: "adorable-bridge" }, message), parentOrigin);

  const report = () =>
    post({ type: "location", path: location.pathname + location.search + location.hash, title: document.title });
  ["pushState", "replaceState"].forEach((method) => {
    const original = history[method];
    history[method] = function () {
      const result = original.apply(this, arguments);
      report();
      return result;
    };
  });
  addEventListener("popstate", report);
  addEventListener("hashchange", report);

  const makeRing = (outline, fill) => {
    const el = document.createElement("div");
    el.setAttribute("data-adorable", "");
    el.style.cssText =
      "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;display:none;border-radius:2px;outline:1.5px solid " +
      outline + ";background:" + fill;
    return el;
  };
  const hoverRing = makeRing("rgba(14,165,233,.9)", "rgba(56,189,248,.08)");
  const pickRing = makeRing("rgb(99,102,241)", "rgba(99,102,241,.1)");
  const label = document.createElement("div");
  label.setAttribute("data-adorable", "");
  label.style.cssText =
    "position:fixed;pointer-events:none;z-index:2147483647;display:none;font:500 11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:rgb(99,102,241);padding:0 6px;border-radius:4px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis";
  const cursor = document.createElement("style");
  cursor.setAttribute("data-adorable", "");
  cursor.textContent = "*{cursor:crosshair!important}";

  const describe = (el) => {
    const classes = typeof el.className === "string" ? el.className.trim().split(/\s+/).filter(Boolean) : [];
    return el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (classes.length ? "." + classes.slice(0, 2).join(".") : "");
  };
  const pathOf = (el) => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.body && parts.length < 6; node = node.parentElement)
      parts.unshift(describe(node));
    return parts.join(" > ");
  };

  const place = (ring, target, withLabel) => {
    if (!target || !target.isConnected) {
      ring.style.display = "none";
      if (withLabel) label.style.display = "none";
      return;
    }
    const r = target.getBoundingClientRect();
    ring.style.display = "block";
    ring.style.left = r.left + "px";
    ring.style.top = r.top + "px";
    ring.style.width = r.width + "px";
    ring.style.height = r.height + "px";
    if (withLabel) {
      label.textContent = describe(target);
      label.style.display = "block";
      label.style.left = Math.max(0, r.left) + "px";
      label.style.top = (r.top > 20 ? r.top - 19 : r.bottom + 2) + "px";
    }
  };

  let selecting = false;
  let hovered = null;
  let picked = null;

  const resolve = (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1 || el === document.documentElement || el === document.body) return null;
    return el.hasAttribute("data-adorable") ? null : el;
  };
  const onMove = (event) => {
    hovered = resolve(event);
    place(hoverRing, hovered === picked ? null : hovered, false);
  };
  const swallow = (event) => {
    if (!resolve(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onClick = (event) => {
    const el = resolve(event);
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    picked = el;
    place(hoverRing, null, false);
    place(pickRing, picked, true);
    const html = el.outerHTML;
    const r = el.getBoundingClientRect();
    post({
      type: "selected",
      element: {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: typeof el.className === "string" ? el.className : "",
        text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
        path: pathOf(el),
        html: html.length > 1500 ? html.slice(0, 1500) + "…" : html,
        page: location.pathname,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        viewport: { width: innerWidth, height: innerHeight },
      },
    });
  };
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    setSelecting(false);
    post({ type: "select-cancelled" });
  };
  // The picked element moves with scrolling and resizing; the parent's prompt card follows it.
  let rectPending = false;
  const refresh = () => {
    place(pickRing, picked, true);
    place(hoverRing, hovered === picked ? null : hovered, false);
    if (!picked || rectPending) return;
    rectPending = true;
    requestAnimationFrame(() => {
      rectPending = false;
      if (!picked) return;
      const r = picked.getBoundingClientRect();
      post({ type: "selection-rect", rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
    });
  };

  const setSelecting = (on) => {
    if (on === selecting) return;
    selecting = on;
    const method = on ? "addEventListener" : "removeEventListener";
    document[method]("mousemove", onMove, true);
    document[method]("mousedown", swallow, true);
    document[method]("pointerdown", swallow, true);
    document[method]("click", onClick, true);
    document[method]("keydown", onKey, true);
    window[method]("scroll", refresh, true);
    window[method]("resize", refresh);
    if (on) {
      document.documentElement.append(hoverRing, pickRing, label, cursor);
    } else {
      hovered = null;
      picked = null;
      [hoverRing, pickRing, label, cursor].forEach((el) => el.remove());
    }
  };

  addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
    const data = event.data || {};
    if (data.source !== "adorable") return;
    if (data.type === "select") setSelecting(Boolean(data.on));
    if (data.type === "clear-selection") {
      picked = null;
      place(pickRing, null, true);
    }
    if (data.type === "history") data.direction === "back" ? history.back() : history.forward();
  });

  report();
  post({ type: "ready" });
})();
`;
