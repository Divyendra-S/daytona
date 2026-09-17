/**
 * Where in the source a picked element's classes are written.
 *
 * The preview reports the rendered class string and nothing about files, so the string literal is
 * found by what it says: a literal whose utilities are all among the element's rendered classes
 * is a candidate, and the one that accounts for most of them wins — helped by the element's text
 * or tag sitting next to it, or by living in the page's own route file. Classes that come from a
 * shared component (`components/ui`, a `cva(...)`) are set aside first, which leaves the ones
 * written at the call site; editing the shared literal would restyle every button in the app.
 *
 * It never guesses. No clear winner is a refusal with a reason, and the panel says so.
 *
 * Pure: the route hands it file contents.
 */

export type SourceFile = { path: string; content: string };

export type Literal = {
  /** Offsets of the text between the quotes. */
  start: number;
  end: number;
  value: string;
  /** A template literal with `${…}` in it: its text is not the whole class string. */
  dynamic: boolean;
  inCva: boolean;
  /** Literals of one `cn(…)` call share a group: together they are one element's classes. */
  group: number;
};

export type LocateTarget = {
  tag: string;
  classes: string;
  text: string;
  page: string;
};

export type LocateRefusal =
  | "not-found"
  | "ambiguous"
  | "shared-component"
  | "no-class"
  | "dynamic"
  | "stale";

export type Located =
  | {
      ok: true;
      file: string;
      start: number;
      end: number;
      literal: string;
      line: number;
      warnings: string[];
    }
  | {
      ok: false;
      reason: LocateRefusal;
      candidates: { file: string; line: number }[];
    };

const lineAt = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

/**
 * The string literals of a JS/TS source. Comments are skipped; a quote that does not close on its
 * line is JSX text with an apostrophe in it, not a string, and costs at most that line.
 */
export const literalsIn = (source: string): Literal[] => {
  const found: Omit<Literal, "inCva" | "group">[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      index = end === -1 ? source.length : end;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
    } else if (char === '"' || char === "'" || char === "`") {
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === "\n" && char !== "`") break;
        end += source[end] === "\\" ? 2 : 1;
      }
      if (source[end] !== char) {
        index += 1;
        continue;
      }
      const value = source.slice(index + 1, end);
      found.push({
        start: index + 1,
        end,
        value,
        dynamic: char === "`" && value.includes("${"),
      });
      index = end + 1;
    } else index += 1;
  }

  // The spans of class-merging calls, by matching parentheses outside the literals.
  const inLiteral = (offset: number) =>
    found.some((literal) => offset >= literal.start && offset < literal.end);
  const calls: { name: string; start: number; end: number }[] = [];
  for (const match of source.matchAll(/\b(cn|clsx|twMerge|cva)\(/g)) {
    const open = match.index + match[0].length;
    if (inLiteral(match.index)) continue;
    let depth = 1;
    let at = open;
    for (; at < source.length && depth > 0; at += 1) {
      if (inLiteral(at)) continue;
      if (source[at] === "(") depth += 1;
      if (source[at] === ")") depth -= 1;
    }
    calls.push({ name: match[1], start: open, end: at });
  }

  return found.map((literal) => {
    const around = calls.filter(
      (call) => literal.start >= call.start && literal.end <= call.end,
    );
    return {
      ...literal,
      inCva: around.some((call) => call.name === "cva"),
      group: around.length ? around[0].start : literal.start,
    };
  });
};

const tokensOf = (classes: string) => classes.split(/\s+/).filter(Boolean);

/** A literal that could be a class string at all: utilities, not prose or an import path. */
const CLASS_TOKEN = /^!?[a-z@*\[-][^\s"'`{}<>;]*$/i;

/** The few tokens least likely to be anywhere else, for narrowing the search to some files. */
export const rareTokens = (classes: string, count = 3) =>
  [...new Set(tokensOf(classes))]
    .sort(
      (a, b) =>
        Number(b.includes("[")) - Number(a.includes("[")) ||
        b.length - a.length,
    )
    .slice(0, count);

const isSharedFile = (path: string) => /(^|\/)components\/ui\//.test(path);

const routeFiles = (page: string) => {
  const route = page === "/" ? "" : page.replace(/\/$/, "");
  return ["tsx", "jsx", "js"].flatMap((ext) => [
    `app${route}/page.${ext}`,
    `src/app${route}/page.${ext}`,
  ]);
};

type Group = {
  file: SourceFile;
  literals: Literal[];
  tokens: Set<string>;
  score: number;
};

export const locate = (files: SourceFile[], target: LocateTarget): Located => {
  const rendered = new Set(tokensOf(target.classes));
  if (!rendered.size) return { ok: false, reason: "no-class", candidates: [] };

  const shared = new Set<string>();
  const groups = new Map<string, Group>();
  let sawDynamic = false;

  for (const file of files) {
    for (const literal of literalsIn(file.content)) {
      const tokens = tokensOf(literal.value);
      const hits = tokens.filter((token) => rendered.has(token));

      if (literal.dynamic) {
        if (hits.length >= 2) sawDynamic = true;
        continue;
      }
      if (!tokens.length || !tokens.every((token) => CLASS_TOKEN.test(token)))
        continue;
      // twMerge drops the shared utilities a call site overrides, so most is enough here.
      if (isSharedFile(file.path) || literal.inCva) {
        if (tokens.length >= 3 && hits.length / tokens.length >= 0.8)
          hits.forEach((token) => shared.add(token));
        continue;
      }
      if (hits.length !== tokens.length) continue;

      const key = `${file.path}:${literal.group}`;
      const group = groups.get(key) ?? {
        file,
        literals: [],
        tokens: new Set<string>(),
        score: 0,
      };
      group.literals.push(literal);
      tokens.forEach((token) => group.tokens.add(token));
      groups.set(key, group);
    }
  }

  const own = [...rendered].filter((token) => !shared.has(token));
  if (!own.length)
    return { ok: false, reason: "shared-component", candidates: [] };

  const text = target.text.slice(0, 24).trim();
  const routes = routeFiles(target.page);
  const scored = [...groups.values()]
    .map((group) => {
      const first = group.literals[0];
      const last = group.literals[group.literals.length - 1];
      const before = group.file.content.slice(
        Math.max(0, first.start - 200),
        first.start,
      );
      // The element's own text comes before the next element's classes.
      const after = group.file.content
        .slice(last.end, last.end + 600)
        .split("className=")[0];
      const covered = own.filter((token) => group.tokens.has(token)).length;
      return {
        ...group,
        score:
          covered / own.length +
          (text.length >= 4 && after.includes(text) ? 0.2 : 0) +
          (new RegExp(`<${target.tag}\\b[^<]*$`).test(before) ? 0.1 : 0) +
          (routes.includes(group.file.path) ? 0.1 : 0),
      };
    })
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, 5).map((group) => ({
    file: group.file.path,
    line: lineAt(group.file.content, group.literals[0].start),
  }));

  const [best, second] = scored;
  if (!best || best.score < 0.6)
    return {
      ok: false,
      reason: sawDynamic
        ? "dynamic"
        : shared.size
          ? "shared-component"
          : "not-found",
      candidates,
    };
  if (second && best.score - second.score < 0.15)
    return { ok: false, reason: "ambiguous", candidates };

  const literal = best.literals.reduce((widest, current) =>
    tokensOf(current.value).length > tokensOf(widest.value).length
      ? current
      : widest,
  );
  return {
    ok: true,
    file: best.file.path,
    start: literal.start,
    end: literal.end,
    literal: literal.value,
    line: lineAt(best.file.content, literal.start),
    warnings: best.literals.length > 1 ? ["conditional"] : [],
  };
};

/**
 * The literal a previous edit wrote, found again without searching — as long as it is still
 * there exactly once; the agent or the user may have changed the file since.
 */
export const locateHint = (
  file: SourceFile,
  literal: string,
): Located | null => {
  const matches = literalsIn(file.content).filter(
    (found) => !found.dynamic && found.value === literal,
  );
  if (matches.length !== 1) return null;
  const [match] = matches;
  return {
    ok: true,
    file: file.path,
    start: match.start,
    end: match.end,
    literal,
    line: lineAt(file.content, match.start),
    warnings: [],
  };
};
