import { NextResponse } from "next/server";
import { authorizeProject } from "@/lib/project-access";
import { readProjectFile, writeProjectFile } from "@/lib/project-files";
import { run, shellQuote } from "@/lib/project-runtime";
import { editClasses, validChange, type StyleChange } from "@/lib/style-edit";
import {
  GLOBAL_STYLESHEETS,
  isOfferedFont,
  withFontImport,
} from "@/lib/style-fonts";
import {
  locate,
  locateHint,
  rareTokens,
  type Located,
  type SourceFile,
} from "@/lib/style-locate";

const MAX_FILES = 30;
const MAX_FILE_BYTES = 100_000;
const SOURCES = ["tsx", "jsx", "ts", "js"]
  .map((ext) => `--include=*.${ext}`)
  .join(" ");
const SKIPPED = ["node_modules", ".next", ".git", "dist", "build", "out"]
  .map((dir) => `--exclude-dir=${dir}`)
  .join(" ");

/**
 * The files that could hold the element's classes, in one round trip to the sandbox: those that
 * mention its rarest utilities, plus every `cva(` so shared components can be told apart. Each
 * file follows a marker line no source contains.
 */
const candidateFiles = async (
  projectId: string,
  classes: string,
): Promise<SourceFile[]> => {
  const marker = `@@adorable-${crypto.randomUUID()}`;
  // Rarest utility first, shared components last: the cut at MAX_FILES takes the least likely.
  const greps = [...rareTokens(classes), "cva("]
    .map((token) => `grep -rlF ${SOURCES} ${SKIPPED} -e ${shellQuote(token)} .`)
    .join(" ; ");
  const script = `{ ${greps} ; } | awk '!seen[$0]++' | head -n ${MAX_FILES} | while IFS= read -r file; do printf '\\n%s %s\\n' ${shellQuote(marker)} "$file"; head -c ${MAX_FILE_BYTES} "$file"; done`;
  const result = await run(
    projectId,
    `sh -c ${shellQuote(script)}`,
    undefined,
    60,
  );

  return result.stdout
    .split(`\n${marker} `)
    .slice(1)
    .map((chunk) => {
      const newline = chunk.indexOf("\n");
      return {
        path: chunk.slice(0, newline).replace(/^\.\//, ""),
        content: chunk.slice(newline + 1),
      };
    });
};

/** Import the family in the project's global stylesheet; false when there is none to put it in. */
const importFont = async (projectId: string, family: string) => {
  for (const path of GLOBAL_STYLESHEETS) {
    const file = await readProjectFile(projectId, path);
    if (!file.ok) continue;
    const next = withFontImport(file.content, family);
    if (next !== file.content) await writeProjectFile(projectId, path, next);
    return true;
  }
  return false;
};

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max ? value : null;

/**
 * Change style properties of an element picked in the preview, by rewriting its Tailwind classes
 * in the project's source. No agent: the literal is located (`lib/style-locate.ts`), edited
 * (`lib/style-edit.ts`) and written back; the dev server's hot reload does the rest. A literal
 * that cannot be pinned down is a 409 with the reason, never a guess.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    element?: Record<string, unknown>;
    changes?: unknown;
    hint?: Record<string, unknown>;
  } | null;
  const tag = text(body?.element?.tag, 40);
  const classes = text(body?.element?.classes, 4_000);
  const page = text(body?.element?.page, 500);
  const elementText = text(body?.element?.text, 400);
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  if (
    tag === null ||
    !/^[a-z][a-z0-9-]*$/.test(tag) ||
    classes === null ||
    page === null ||
    elementText === null ||
    !changes.length ||
    changes.length > 20 ||
    !changes.every(validChange) ||
    changes.some(
      (change: StyleChange) =>
        change.prop === "fontFamily" &&
        change.value !== null &&
        !isOfferedFont(change.value),
    )
  ) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const valid = changes as StyleChange[];

  const hintFile = text(body?.hint?.file, 500);
  const hintLiteral = text(body?.hint?.literal, 4_000);
  let source: SourceFile | null = null;
  let located: Located | null = null;

  if (hintFile && hintLiteral) {
    const file = await readProjectFile(projectId, hintFile);
    if (file.ok) {
      source = { path: file.path, content: file.content };
      located = locateHint(source, hintLiteral);
    }
  }
  if (!located) {
    located = locate(await candidateFiles(projectId, classes), {
      tag,
      classes,
      text: elementText,
      page,
    });
    // The search output is cut at a size limit and passes through a shell; the file that gets
    // written back is read again, byte for byte.
    const file = located.ok
      ? await readProjectFile(projectId, located.file)
      : null;
    source = file?.ok ? { path: file.path, content: file.content } : null;
  }
  if (!located.ok) return NextResponse.json(located, { status: 409 });
  if (
    !source ||
    source.content.slice(located.start, located.end) !== located.literal
  ) {
    return NextResponse.json(
      { reason: "stale", candidates: [] },
      { status: 409 },
    );
  }

  const delimiter = source.content[located.start - 1];
  const quote = delimiter === "'" ? '"' : "'";
  const edited = editClasses(located.literal, valid, quote);
  if (
    /[\\\n`]|\$\{/.test(edited.classes) ||
    edited.classes.includes(delimiter)
  ) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const warnings = [...located.warnings];
  const family = valid.find((change) => change.prop === "fontFamily")?.value;
  if (family && !(await importFont(projectId, family)))
    warnings.push("font-not-imported");

  await writeProjectFile(
    projectId,
    located.file,
    source.content.slice(0, located.start) +
      edited.classes +
      source.content.slice(located.end),
  );

  return NextResponse.json({
    file: located.file,
    line: located.line,
    literal: edited.classes,
    classes: editClasses(classes, valid, quote).classes,
    warnings,
    shadowedBy: edited.shadowedBy,
  });
}
