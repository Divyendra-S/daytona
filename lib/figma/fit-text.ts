/**
 * Text, pinned to the width Figma says it is.
 *
 * A design's own face is not always fetchable — a foundry trial, a licensed family, anything
 * not on Google Fonts — and the browser then draws the same string in something else. Every
 * consequence of that is a *layout* bug rather than a typography one: two text nodes that
 * overlap exactly in Figma stop overlapping here, because each is centred on its own box and
 * each measures a different width. One design puts a gradient copy of "Banking Network" on top
 * of the last two words of a dark heading; substituted, the wide fallback pushed the 30-
 * character box's words right and the 15-character box's words left and the two copies came
 * apart by 40px, which reads as a rendering bug and is not one.
 *
 * Figma ships the answer in `derivedTextData.baselines`: the ink width of every line, in the
 * design's own font. `data-fit` carries the widest of them, and this scales the line to it. A
 * face that *did* load measures what it should and is left alone.
 *
 * `offsetWidth`, not `getBoundingClientRect`: the canvas puts the frame under a zoom transform
 * and a rect is in screen pixels, so the ratio would come out as the zoom level. Layout pixels
 * are what the design is written in.
 *
 * Self-contained on purpose — `fitScript` serialises this very function into the document for
 * the surfaces that render it without a parent (an exported file, the diff harness).
 */
export const fitText = (doc: Document) => {
  const nodes = doc.querySelectorAll("[data-fit]");
  for (let i = 0; i < nodes.length; i += 1) {
    const box = nodes[i] as HTMLElement;
    const line = box.firstElementChild as HTMLElement | null;
    const target = Number(box.getAttribute("data-fit"));
    if (!line || !(target > 0)) continue;

    line.style.transform = "";
    const actual = line.offsetWidth;
    if (!actual) continue;

    const ratio = target / actual;
    /**
     * Two percent, because the question this asks is "did a different face load", not "is this
     * pixel-exact". A face that *did* load still measures a little off — hinting, tracking
     * rounding, the browser's own shaping — and correcting that noise moves every glyph in the
     * line to buy back a fraction of a pixel at its edge, which measured worse. A substitution
     * is never subtle: the ones in this corpus are 5% to 20% out.
     */
    if (!(Math.abs(ratio - 1) > 0.02)) continue;

    // The scale has to keep whichever edge the alignment pinned, or fitting a centred line
    // would move it off centre.
    const justify = doc.defaultView?.getComputedStyle(box).justifyContent ?? "";
    line.style.transformOrigin =
      justify === "flex-end"
        ? "right center"
        : justify === "center"
          ? "center center"
          : "left center";
    line.style.transform = `scaleX(${Math.round(ratio * 10000) / 10000})`;
  }
};

/** The same pass, for a document that has no parent to run it. See `fitText`. */
export const fitScript = () =>
  `<script>(${fitText.toString()})(document);document.fonts&&document.fonts.ready.then(function(){(${fitText.toString()})(document)})</script>`;
