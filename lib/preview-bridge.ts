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
 * For the property inspector it reports the picked element's computed styles, and shows a change
 * at once as an inline override — only properties on its own list, only on the picked element.
 * The real change arrives later as new classes through hot reload; the parent is told when the
 * class attribute changes and decides when the overrides come off.
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
  let picks = 0;

  // What the inspector reads, and the only properties it may override.
  const READ = ["font-family", "font-size", "font-weight", "color", "text-align", "line-height", "letter-spacing",
    "padding-top", "padding-right", "padding-bottom", "padding-left", "row-gap", "column-gap", "display",
    "flex-direction", "background-color", "background-image", "border-top-width", "border-top-style",
    "border-top-color", "border-top-left-radius", "box-shadow", "opacity", "object-fit"];
  const WRITE = ["font-family", "font-size", "font-weight", "color", "text-align", "line-height", "letter-spacing",
    "padding-top", "padding-right", "padding-bottom", "padding-left", "gap", "flex-direction", "background-color",
    "border-width", "border-style", "border-color", "border-radius", "box-shadow", "opacity", "object-fit"];
  const classOf = (el) => el.getAttribute("class") || "";
  const stylesOf = (el) => {
    const computed = getComputedStyle(el);
    const styles = {};
    READ.forEach((prop) => { styles[prop] = computed.getPropertyValue(prop); });
    return styles;
  };

  // Inline values the overrides replaced, put back when the overrides come off.
  let replaced = {};
  const override = (styles) => {
    if (!picked || !styles) return;
    Object.keys(styles).forEach((prop) => {
      if (WRITE.indexOf(prop) === -1) return;
      if (!(prop in replaced))
        replaced[prop] = [picked.style.getPropertyValue(prop), picked.style.getPropertyPriority(prop)];
      const value = styles[prop];
      if (typeof value === "string") picked.style.setProperty(prop, value, "important");
      else restore(prop);
    });
    refresh();
  };
  const restore = (prop) => {
    const was = replaced[prop];
    delete replaced[prop];
    if (!picked || !was) return;
    if (was[0]) picked.style.setProperty(prop, was[0], was[1]);
    else picked.style.removeProperty(prop);
  };
  const clearOverrides = () => Object.keys(replaced).forEach(restore);

  let lostPending = false;
  const watcher = new MutationObserver((records) => {
    if (!picked) return;
    if (records.some((record) => record.type === "attributes" && record.target === picked))
      post({ type: "class-changed", classes: classOf(picked) });
    if (picked.isConnected || lostPending) return;
    // Hot reload may swap the node a frame after removing it; only a node still gone is lost.
    lostPending = true;
    requestAnimationFrame(() => {
      lostPending = false;
      if (!picked || picked.isConnected) return;
      unpick();
      post({ type: "selection-lost" });
    });
  });
  const unpick = () => {
    clearOverrides();
    replaced = {};
    watcher.disconnect();
    picked = null;
    place(pickRing, null, true);
  };

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
    unpick();
    picked = el;
    watcher.observe(el, { attributes: true, attributeFilter: ["class"] });
    watcher.observe(document.body, { childList: true, subtree: true });
    place(hoverRing, null, false);
    place(pickRing, picked, true);
    const html = el.outerHTML;
    const r = el.getBoundingClientRect();
    let instances = 0;
    const same = document.getElementsByTagName(el.tagName);
    for (let i = 0; i < same.length; i++) if (classOf(same[i]) === classOf(el)) instances++;
    post({
      type: "selected",
      element: {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        // The attribute, not the property: an SVG element's className is not a string.
        classes: classOf(el),
        text: (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
        path: pathOf(el),
        html: html.length > 1500 ? html.slice(0, 1500) + "…" : html,
        page: location.pathname,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        viewport: { width: innerWidth, height: innerHeight },
        styles: stylesOf(el),
        textOnly: el.childElementCount === 0 && Boolean((el.textContent || "").trim()),
        instances: instances,
        pick: ++picks,
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
  function refresh() {
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
  }

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
      unpick();
      [hoverRing, pickRing, label, cursor].forEach((el) => el.remove());
    }
  };

  addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
    const data = event.data || {};
    if (data.source !== "adorable") return;
    if (data.type === "select") setSelecting(Boolean(data.on));
    if (data.type === "clear-selection") unpick();
    if (data.type === "style") override(data.styles);
    // The source has caught up: the classes do the work now, and the panel reads the result.
    if (data.type === "clear-styles" && picked) {
      clearOverrides();
      refresh();
      post({ type: "styles-synced", classes: classOf(picked), styles: stylesOf(picked) });
    }
    if (data.type === "font" && typeof data.href === "string" &&
        data.href.indexOf("https://fonts.googleapis.com/css2?") === 0 &&
        !document.querySelector('link[data-adorable][href="' + data.href.replace(/"/g, "") + '"]')) {
      const link = document.createElement("link");
      link.setAttribute("data-adorable", "");
      link.rel = "stylesheet";
      link.href = data.href;
      document.head.appendChild(link);
    }
    if (data.type === "history") data.direction === "back" ? history.back() : history.forward();
  });

  report();
  post({ type: "ready" });
})();
`;
