/**
 * Figma's vector network blob, decoded to SVG paths.
 *
 * A VECTOR node's geometry is not in its `NodeChange` — `vectorData` holds only a blob index
 * and a `normalizedSize`. The blob is a packed binary format of its own, outside the Kiwi
 * schema, with no public documentation. This layout was derived from a real payload and holds
 * exactly — byte for byte, 114 of 114 networks — on the corpus in `lib/__fixtures__`:
 *
 * ```
 * u32 vertexCount, segmentCount, regionCount, flag
 * vertexCount  × { x: f32, y: f32, style: u32 }                          12 bytes
 * segmentCount × { start: u32, sx: f32, sy: f32, end: u32, ex: f32, ey: f32 }  24 bytes,
 *                with one u32 written *between* consecutive segments (always 0 so far)
 * regionCount  × { windingRule: u32, loopCount: u32, loops: [ n: u32, segmentIndex × n ] }
 * ```
 *
 * The tangents are what confirm it: a quarter-circle in the corpus comes out with handles of
 * 46.944 on a radius of 85 — 0.5523 × r, the Bézier circle constant. Nothing but the right
 * offsets produces that number.
 *
 * It is still a proprietary format that can change without notice. `parseVectorNetwork`
 * returns null rather than guessing when the bytes do not fit.
 */

export type VectorNetwork = {
  /**
   * `style` indexes `vectorData.styleOverrideTable`, which is where a *per-vertex* corner
   * radius lives — the third field of every 12-byte vertex, and the reason the stride is 12
   * rather than 8. Read as nothing, a bracket whose two ends are rounded to 500 and 600 comes
   * back with square corners, and the node carries no `cornerRadius` of its own to hint at it.
   */
  vertices: { x: number; y: number; style?: number }[];
  segments: {
    start: number;
    end: number;
    /** Control-point offsets, relative to their own vertex. */
    sx: number;
    sy: number;
    ex: number;
    ey: number;
  }[];
  regions: { windingRule: number; loops: number[][] }[];
};

export const parseVectorNetwork = (
  bytes: Uint8Array | undefined,
): VectorNetwork | null => {
  if (!bytes || bytes.length < 16) return null;

  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (at: number) => {
      if (at + 4 > bytes.length) throw new RangeError("short blob");
      return view.getUint32(at, true);
    };
    const f32 = (at: number) => {
      if (at + 4 > bytes.length) throw new RangeError("short blob");
      return view.getFloat32(at, true);
    };

    const vertexCount = u32(0);
    const segmentCount = u32(4);
    const regionCount = u32(8);

    let at = 16;
    const vertices: VectorNetwork["vertices"] = [];
    for (let i = 0; i < vertexCount; i += 1, at += 12) {
      vertices.push({ x: f32(at), y: f32(at + 4), style: u32(at + 8) });
    }

    const segments: VectorNetwork["segments"] = [];
    for (let i = 0; i < segmentCount; i += 1) {
      // The separator. Not a segment field: it is absent before the first one, which is why a
      // 28-byte stride reads every open path four bytes past its end.
      if (i > 0) at += 4;
      const segment = {
        start: u32(at),
        sx: f32(at + 4),
        sy: f32(at + 8),
        end: u32(at + 12),
        ex: f32(at + 16),
        ey: f32(at + 20),
      };
      if (segment.start >= vertexCount || segment.end >= vertexCount)
        return null;
      segments.push(segment);
      at += 24;
    }

    const regions: VectorNetwork["regions"] = [];
    for (let i = 0; i < regionCount; i += 1) {
      const windingRule = u32(at);
      const loopCount = u32(at + 4);
      at += 8;
      const loops: number[][] = [];
      for (let l = 0; l < loopCount; l += 1) {
        const count = u32(at);
        at += 4;
        const loop: number[] = [];
        for (let k = 0; k < count; k += 1, at += 4) {
          const index = u32(at);
          if (index >= segmentCount) return null;
          loop.push(index);
        }
        loops.push(loop);
      }
      regions.push({ windingRule, loops });
    }

    // Exact consumption is the check that matters: a wrong stride almost always lands here.
    return at === bytes.length ? { vertices, segments, regions } : null;
  } catch {
    return null;
  }
};

const round = (n: number) => Math.round(n * 100) / 100;

const isFlat = (segment: VectorNetwork["segments"][number]) =>
  segment.sx === 0 && segment.sy === 0 && segment.ex === 0 && segment.ey === 0;

/**
 * One segment, drawn from `from` towards its other end.
 *
 * A loop walks its segments in order but not necessarily in their own direction, so a segment
 * traversed backwards has to swap both its vertices and its handles — miss that and curves
 * bulge the wrong way.
 */
const draw = (
  network: VectorNetwork,
  index: number,
  from: number,
): { d: string; to: number; flat: boolean } => {
  const segment = network.segments[index];
  const forward = segment.start === from;
  const to = forward ? segment.end : segment.start;
  const end = network.vertices[to];
  if (!end) return { d: "", to: from, flat: true };

  if (isFlat(segment))
    return { d: `L${round(end.x)} ${round(end.y)}`, to, flat: true };

  const startVertex = network.vertices[from];
  const c1 = forward
    ? { x: startVertex.x + segment.sx, y: startVertex.y + segment.sy }
    : { x: startVertex.x + segment.ex, y: startVertex.y + segment.ey };
  const c2 = forward
    ? { x: end.x + segment.ex, y: end.y + segment.ey }
    : { x: end.x + segment.sx, y: end.y + segment.sy };

  return {
    d: `C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(end.x)} ${round(end.y)}`,
    to,
    flat: false,
  };
};

type Point = { x: number; y: number };

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

/** `t` units from `here` along the line towards `other`. */
const towards = (here: Point, other: Point, t: number): Point => {
  const span = distance(here, other);
  if (!span) return here;
  return {
    x: here.x + ((other.x - here.x) * t) / span,
    y: here.y + ((other.y - here.y) * t) / span,
  };
};

/**
 * Figma's vector corner radius, which is geometry and not a `border-radius`.
 *
 * `cornerRadius` on a VECTOR rounds every corner of its network, and a design can lean on it
 * hard: five waves across one hero are 13-point polylines with **zero** tangents and a radius of
 * 333 — larger than any of their own segments — so every straight run is consumed by its two
 * fillets and the zigzag reads as a sine. Drawn without it they are exactly the zigzag the blob
 * stores, and nothing reports a thing, because nothing was approximated: the geometry was read
 * correctly and then half of it was left on the node.
 *
 * Only a corner between two straight segments is rounded. Where a segment already carries
 * tangents the curve is the designer's own, and Figma leaves those alone too.
 *
 * The trim is capped at half of each adjoining edge, which is what makes neighbouring fillets
 * meet exactly rather than overrun each other when the radius is larger than the shape.
 */
const roundCorners = (
  points: Point[],
  flats: boolean[],
  curves: string[],
  closed: boolean,
  /** One radius per point: Figma rounds each corner of a network on its own. */
  radii: number[],
): string => {
  const n = points.length;
  const steps = closed ? n : n - 1;
  const at = (i: number) => points[((i % n) + n) % n];

  const trim = new Array<number>(n).fill(0);
  const arc = new Array<number>(n).fill(0);
  const sweep = new Array<number>(n).fill(0);

  for (let i = 0; i < n; i += 1) {
    const incoming = closed ? (i - 1 + n) % n : i - 1;
    // An open path's two ends are not corners; they are where it starts and stops.
    if (incoming < 0 || i >= steps) continue;
    if (!flats[incoming] || !flats[i]) continue;

    const prev = at(i - 1);
    const here = at(i);
    const next = at(i + 1);
    const back = distance(prev, here);
    const on = distance(here, next);
    if (!back || !on) continue;

    const u = { x: (prev.x - here.x) / back, y: (prev.y - here.y) / back };
    const v = { x: (next.x - here.x) / on, y: (next.y - here.y) / on };
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    // Straight through, or doubled back along itself: there is no corner to take.
    if (!(angle > 1e-3 && angle < Math.PI - 1e-3)) continue;

    const radius = radii[i] ?? 0;
    if (!(radius > 0)) continue;
    /**
     * Half of each adjoining edge, so neighbouring fillets meet rather than overrun.
     *
     * Sharing the edge in proportion to what its two ends ask for — letting a corner take the
     * whole of an edge whose other end is square — looks like the more faithful rule and is
     * not: measured against Figma it moved this corpus's one heavily-filleted shape from 5.22
     * to 7.11. Figma caps at half regardless of what the neighbour wants.
     */
    const half = Math.tan(angle / 2);
    const t = Math.min(radius / half, back / 2, on / 2);
    if (!(t > 0)) continue;
    trim[i] = t;
    arc[i] = t * half;
    // Which way the path turns decides the arc's direction; y runs down, so a positive cross
    // product is a clockwise turn on screen.
    sweep[i] =
      (here.x - prev.x) * (next.y - here.y) -
        (here.y - prev.y) * (next.x - here.x) >
      0
        ? 1
        : 0;
  }

  const start = trim[0] > 0 ? towards(at(0), at(1), trim[0]) : at(0);
  const out = [`M${round(start.x)} ${round(start.y)}`];
  for (let i = 0; i < steps; i += 1) {
    if (!flats[i]) {
      out.push(curves[i]);
      continue;
    }
    const j = (i + 1) % n;
    const end = trim[j] > 0 ? towards(at(j), at(i), trim[j]) : at(j);
    out.push(`L${round(end.x)} ${round(end.y)}`);
    if (trim[j] > 0) {
      const after = towards(at(j), at(j + 1), trim[j]);
      out.push(
        `A${round(arc[j])} ${round(arc[j])} 0 0 ${sweep[j]} ${round(after.x)} ${round(after.y)}`,
      );
    }
  }
  return out.join("");
};

const subpath = (
  network: VectorNetwork,
  indices: number[],
  close: boolean,
  radius = 0,
  /** Per-`styleID` radii from `vectorData.styleOverrideTable`. */
  styles?: Map<number, number>,
) => {
  /**
   * A vertex's own radius when the network gives it one, and the node's otherwise.
   *
   * Figma rounds each corner separately: the two ends of one bracket are 500 and 600 while
   * every other corner is square, and the node itself carries no `cornerRadius` at all. Read as
   * a single value the shape came back with square corners, and nothing said so — the geometry
   * decoded perfectly and there was no radius in the node to notice was missing.
   */
  const radiusAt = (v: { style?: number }) =>
    (v.style !== undefined && styles?.get(v.style)) || radius;
  if (!indices.length) return "";

  const first = network.segments[indices[0]];
  // A one-segment run starts at its own start; a longer one starts at whichever end the second
  // segment does not touch, so the walk never begins by going backwards.
  let cursor = first.start;
  if (indices.length > 1) {
    const second = network.segments[indices[1]];
    if (
      second &&
      (second.start === first.start || second.end === first.start)
    ) {
      cursor = first.end;
    }
  }

  const origin = network.vertices[cursor];
  if (!origin) return "";

  const points: Point[] = [origin];
  const radii: number[] = [radiusAt(origin)];
  const flats: boolean[] = [];
  const curves: string[] = [];
  for (const index of indices) {
    const step = draw(network, index, cursor);
    const point = network.vertices[step.to];
    if (!point) break;
    points.push(point);
    radii.push(radiusAt(point));
    flats.push(step.flat);
    curves.push(step.d);
    cursor = step.to;
  }
  // A closed walk comes back to its own first vertex; carrying the duplicate would put a corner
  // on top of the seam.
  if (close && points.length > 1) {
    points.pop();
    radii.pop();
  }

  const d = radii.some((r) => r > 0)
    ? roundCorners(points, flats, curves, close, radii)
    : `M${round(origin.x)} ${round(origin.y)}${curves.join("")}`;
  return close ? `${d}Z` : d;
};

/**
 * Filled regions, and whatever is left over as open paths to stroke.
 *
 * Both come back, because a Figma vector can be one, the other or both — a stroked open curve
 * has no regions at all, and dropping it because `regions` is empty loses every line, arrow and
 * signature in a design.
 */
export const networkToPaths = (
  network: VectorNetwork,
  /** `cornerRadius`, in the network's own units — see `roundCorners`. */
  radius = 0,
  /** Per-vertex radii, by the `styleID` each vertex carries. See `subpath`. */
  styles?: Map<number, number>,
): {
  fills: { d: string; evenOdd: boolean }[];
  /** `closed` runs come back to their own first vertex — Figma fills those even with no region. */
  strokes: { d: string; closed: boolean }[];
} => {
  const fills = network.regions.map((region) => ({
    d: region.loops
      .map((loop) => subpath(network, loop, true, radius, styles))
      .join(""),
    // 0 is ODD in the enum the payload ships; 1 is NONZERO, which is the common case.
    evenOdd: region.windingRule === 0,
  }));

  // Chain the segments into runs, so a polyline is one path with real joins rather than a
  // string of separate segments each drawing its own caps.
  //
  // **Every** segment, including the ones a region claims. A region says what is *filled*; the
  // stroke follows the whole network regardless. Skipping them left an arrow icon's chevron with
  // no stroke of its own and only its region to draw — and a region is closed, so `subpath`
  // fabricated the edge from its last vertex back to its first. Two segments meeting at a point
  // became a triangle. Figma stores that chevron as a zero-area two-segment region and paints
  // nothing for it; what you see is three stroked segments.
  const strokes: { d: string; closed: boolean }[] = [];
  const remaining = network.segments.map((_, index) => index);
  const used = new Set<number>();

  for (const index of remaining) {
    if (used.has(index)) continue;
    const run = [index];
    used.add(index);

    let tail = network.segments[index].end;
    for (;;) {
      const next = remaining.find(
        (candidate) =>
          !used.has(candidate) &&
          (network.segments[candidate].start === tail ||
            network.segments[candidate].end === tail),
      );
      if (next === undefined) break;
      used.add(next);
      run.push(next);
      const segment = network.segments[next];
      tail = segment.start === tail ? segment.end : segment.start;
    }

    const first = network.segments[run[0]];
    const start = run.length > 1 ? undefined : first.start;
    const d = subpath(network, run, false, radius, styles);
    // A run that ends where it began is an outline, not a line: same path, different paint.
    const ends = d.match(/([-\d.]+) ([-\d.]+)$/);
    const begins = d.match(/^M([-\d.]+) ([-\d.]+)/);
    const closed =
      run.length > 2 &&
      ends !== null &&
      begins !== null &&
      Math.abs(Number(ends[1]) - Number(begins[1])) < 0.5 &&
      Math.abs(Number(ends[2]) - Number(begins[2])) < 0.5;
    void start;
    if (d) strokes.push({ d, closed });
  }

  return { fills, strokes };
};
