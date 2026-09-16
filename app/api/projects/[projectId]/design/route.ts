import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  entryName,
  exportAs,
  targetOf,
  type TargetId,
} from "@/lib/figma/export-code";
import type { UsedFont } from "@/lib/figma/figma-paste";
import { excludeFromGit } from "@/lib/git-exclude";
import { generateLlmText } from "@/lib/llm-provider";
import { projectPaths } from "@/lib/local-project";
import { authorizeProject } from "@/lib/project-access";
import { readProjectFile, resolveInApp } from "@/lib/project-files";
import { addUsage } from "@/lib/project-storage";

/**
 * A pasted Figma design, put into the project in place of one of its sections.
 *
 * GET says what the design will be converted to (the project's own stack) and which sections
 * the page renders. POST converts the design deterministically (`lib/figma/export-code.ts`),
 * then has the model rebuild the chosen section from it — the export is pixel-exact but
 * absolutely positioned, and the model is what turns it into a responsive section that still
 * fits the file it lands in.
 */

type Section = { name: string; file: string };

/** Where each supported stack keeps the page that lists the sections. */
const ENTRY_PAGES = [
  "app/page.tsx",
  "app/page.jsx",
  "src/app/page.tsx",
  "src/app/page.jsx",
  "pages/index.tsx",
  "pages/index.jsx",
  "src/pages/index.tsx",
  "src/App.tsx",
  "src/App.jsx",
  "src/App.vue",
  "src/routes/+page.svelte",
];

const EXTENSIONS = [
  "",
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".vue",
  ".svelte",
  "/index.tsx",
  "/index.jsx",
];

const SVG = /<svg\b[\s\S]*?<\/svg>/g;
const ASSET = /<svg\s+data-figma-asset="(\d+)"[^>]*\/>/g;
const IMAGE_URL = /\/api\/figma\/image\/[^/"'\s)]+\/[0-9a-f]{40}/g;

// ponytail: fixed prompt budget. The model's context is 262k tokens at roughly 3 characters a
// token, so the design, the section file and the rules must stay under ~150k tokens together;
// chunk the design if bigger frames matter.
const MAX_DESIGN_CHARS = 450_000;

const readText = async (projectId: string, file: string) => {
  const result = await readProjectFile(projectId, file);
  return result.ok ? result.content : null;
};

const isFile = async (projectId: string, file: string) => {
  const target = resolveInApp(projectId, file);
  return Boolean(target && (await stat(target).catch(() => null))?.isFile());
};

/** The export target matching the project's own stack. */
const frameworkOf = (packageJson: string | null): TargetId => {
  let deps: Record<string, string> = {};
  try {
    const pkg = JSON.parse(packageJson ?? "{}");
    deps = { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {}
  if (deps.vue || deps.nuxt) return "vue";
  if (deps.svelte || deps["@sveltejs/kit"]) return "svelte";
  if (deps.react) return deps.tailwindcss ? "tailwind" : "jsx";
  return "html";
};

/** A local import source → the file it names, or null for a package. */
const resolveImport = async (
  projectId: string,
  entry: string,
  source: string,
) => {
  const alias = source.startsWith("@/");
  if (!alias && !source.startsWith(".")) return null;
  const base = alias
    ? source.slice(2)
    : path.posix.join(path.posix.dirname(entry), source);
  for (const root of alias ? ["", "src/"] : [""]) {
    for (const ext of EXTENSIONS) {
      if (await isFile(projectId, `${root}${base}${ext}`))
        return `${root}${base}${ext}`;
    }
  }
  return null;
};

/** The local components the entry page renders, in the order it renders them. */
const sectionsOf = async (projectId: string): Promise<Section[]> => {
  for (const entry of ENTRY_PAGES) {
    const source = await readText(projectId, entry);
    if (source === null) continue;

    const imports = new Map<string, string>();
    for (const [, clause, from] of source.matchAll(
      /import\s+([\s\S]*?)\s+from\s+["']([^"']+)["']/g,
    )) {
      for (const part of clause.replace(/[{}]/g, ",").split(",")) {
        const local = part
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (local && /^[A-Z]\w*$/.test(local)) imports.set(local, from);
      }
    }

    const sections: Section[] = [];
    for (const [, name] of source.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) {
      const from = imports.get(name);
      if (!from || sections.some((s) => s.name === name)) continue;
      const file = await resolveImport(projectId, entry, from);
      if (file) sections.push({ name, file });
    }
    return sections;
  }
  return [];
};

/** Stands in for an image fill whose pixels could not be fetched; the model is told to draw a placeholder. */
const MISSING_IMAGE = "figma-image-unavailable";

/**
 * Image fills, copied into the project so its own server can serve them.
 *
 * One that cannot be fetched (no `FIGMA_TOKEN`, no access to the file) is never left as an
 * `/api/figma/image` URL: that route is this app's, and on the project's own server it 404s
 * into a blank box nobody is told about.
 */
const saveImages = async (projectId: string, code: string, origin: string) => {
  const { app } = projectPaths(projectId);
  let out = code;
  let missing = 0;
  /** Why the first unfetchable image failed, in the image route's own words. */
  let reason: string | null = null;
  for (const url of new Set(code.match(IMAGE_URL) ?? [])) {
    const response = await fetch(`${origin}${url}`).catch(() => null);
    if (!response?.ok) {
      missing += 1;
      reason ??= response
        ? await response
            .json()
            .then((body: { error?: string }) => body.error ?? null)
            .catch(() => `the image route answered ${response.status}`)
        : "the image route could not be reached";
      out = out.split(url).join(MISSING_IMAGE);
      continue;
    }
    const type = response.headers.get("content-type") ?? "image/png";
    const ext = type.split("/")[1]?.split(/[;+]/)[0] || "png";
    const publicPath = `/figma/${url.slice(-40)}.${ext}`;
    await mkdir(path.join(app, "public", "figma"), { recursive: true });
    await writeFile(
      path.join(app, "public", publicPath),
      Buffer.from(await response.arrayBuffer()),
    );
    out = out.split(url).join(publicPath);
  }
  return { code: out, missing, reason };
};

type Design = {
  title?: string;
  /** A Figma scene (or the snapshot extension's box capture): absolutely-positioned markup. */
  html?: string;
  /** The snapshot extension's default capture: the page's own HTML document. */
  document?: string;
  fonts?: UsedFont[];
  size?: { width: number; height: number };
};

const DATA_URI =
  /data:((?:image|font)\/[\w.+-]+|application\/(?:x-)?font-\w+);base64,([A-Za-z0-9+/=]+)/g;

/**
 * A capture's inlined images and fonts, moved into the project's public folder. Megabytes of
 * base64 are nothing the model should read, and the app should serve the files itself. Named by
 * content, so the same image captured twice is one file.
 */
const saveDataUris = async (projectId: string, code: string) => {
  const { app } = projectPaths(projectId);
  const saved = new Map<string, string>();
  for (const [uri, mime, data] of code.matchAll(DATA_URI)) {
    if (saved.has(uri)) continue;
    const bytes = Buffer.from(data, "base64");
    const ext = mime
      .split("/")[1]
      .replace("svg+xml", "svg")
      .replace("jpeg", "jpg")
      .replace(/^(x-)?font-/, "");
    const publicPath = `/captures/${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
    await mkdir(path.join(app, "public", "captures"), { recursive: true });
    await writeFile(path.join(app, "public", publicPath), bytes);
    saved.set(uri, publicPath);
  }
  let out = code;
  for (const [uri, publicPath] of saved) out = out.split(uri).join(publicPath);
  return out;
};

/**
 * The design as code the model reads. A captured page already is code — its own document, with
 * its inlined assets moved into the project. A Figma scene is exported to the project's
 * framework, with its image fills fetched.
 */
const designCode = async (
  projectId: string,
  design: Design,
  framework: TargetId,
  origin: string,
) =>
  design.document
    ? {
        code: await saveDataUris(projectId, design.document),
        missing: 0,
        reason: null as string | null,
      }
    : saveImages(
        projectId,
        exportAs(framework, {
          html: design.html ?? "",
          fonts: design.fonts,
          size: design.size,
          title: design.title,
        }).code,
        origin,
      );

/** The longest fenced block in a reply, or the reply itself. */
const codeOf = (text: string) => {
  const blocks = [...text.matchAll(/```[\w-]*\n([\s\S]*?)```/g)].map(
    (m) => m[1],
  );
  return `${(blocks.sort((a, b) => b.length - a.length)[0] ?? text).trim()}\n`;
};

const SYSTEM = `You are a senior front-end engineer. You replace one section of an existing app with a new design pasted from Figma, so that the section looks like the design while still fitting the codebase. Reply with the complete new contents of the file in a single fenced code block and nothing else.`;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const framework = targetOf(
    frameworkOf(await readText(projectId, "package.json")),
  );
  return NextResponse.json({
    framework: { id: framework.id, label: framework.label },
    sections: await sectionsOf(projectId),
  });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    /** "export": no section to replace — write the converted design into the project for the chat agent. */
    mode?: "export";
    name?: string;
    file?: string;
    design?: Design;
  } | null;

  /*
   * Export only. The design, converted to the project's framework with its images copied in,
   * written under `.figma/` — a dot folder, so TypeScript and the build never pick it up — for
   * the chat agent to read and work from with the user's prompt. The name is server-made, so
   * nothing from the browser becomes a path.
   */
  if (body?.mode === "export") {
    const design = body.design;
    if (!design?.html && !design?.document) {
      return NextResponse.json({ error: "No design to use." }, { status: 400 });
    }
    const framework = targetOf(
      frameworkOf(await readText(projectId, "package.json")),
    );
    const { code, missing, reason } = await designCode(
      projectId,
      design,
      framework.id,
      new URL(req.url).origin,
    );
    const stamp = Date.now().toString(36);
    const file = design.document
      ? `.adorable/captures/${stamp}-capture.html`
      : `.figma/${stamp}-${entryName(framework.id, design.title ?? "")}`;
    const target = resolveInApp(projectId, file)!;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, code);
    // Scratch for the agent, never part of the app: publishing must not commit it.
    await excludeFromGit(projectId, design.document ? ".adorable/" : ".figma/");
    return NextResponse.json({
      ok: true,
      file,
      kind: design.document ? "capture" : "figma",
      framework: framework.label,
      missingImages: missing,
      imageError: reason,
      missingMarker: MISSING_IMAGE,
    });
  }

  // The path comes from the browser, so only a section the page really renders may be written.
  const section = (await sectionsOf(projectId)).find(
    (s) => s.name === body?.name && s.file === body?.file,
  );
  if (!section) {
    return NextResponse.json({ error: "Unknown section." }, { status: 400 });
  }
  const design = body?.design;
  if (!design?.html && !design?.document) {
    return NextResponse.json({ error: "No design to use." }, { status: 400 });
  }

  const userApiKey = (await cookies()).get("user-api-key")?.value;
  const hasGlobalKey = Boolean(process.env["OPENROUTER_API_KEY"]);
  if (!hasGlobalKey && !userApiKey) {
    return NextResponse.json(
      { error: "No API key configured. Please add your API key in settings." },
      { status: 401 },
    );
  }

  const current = await readText(projectId, section.file);
  if (current === null) {
    return NextResponse.json(
      { error: "Section file not found." },
      { status: 404 },
    );
  }

  const framework = targetOf(
    frameworkOf(await readText(projectId, "package.json")),
  );
  const {
    code: withImages,
    missing: missingImages,
    reason: imageError,
  } = await designCode(
    projectId,
    design,
    framework.id,
    new URL(req.url).origin,
  );

  // Vector artwork is most of an export and nothing the model needs to read: it sees a
  // placeholder, and the real SVG goes back in afterwards.
  const assets: string[] = [];
  const compact = withImages.replace(
    SVG,
    (svg) => `<svg data-figma-asset="${assets.push(svg) - 1}" />`,
  );
  if (compact.length > MAX_DESIGN_CHARS) {
    return NextResponse.json(
      {
        error: `This design is too large to hand to the model (${compact.length.toLocaleString()} characters). Paste a smaller frame.`,
      },
      { status: 413 },
    );
  }

  const size = design.size
    ? `${Math.round(design.size.width)}×${Math.round(design.size.height)}`
    : "its original";
  const described = design.document
    ? "a section captured from a live website: its own HTML document, with the page's stylesheet rules kept"
    : `a deterministic export of the Figma frame: absolutely positioned boxes at the frame's ${size} size`;
  const prompt = `The project uses ${framework.label}. Replace the \`${section.name}\` component in \`${section.file}\` with the pasted design.

Rules:
- Keep \`${section.name}\` exported under the same name with the same props, and keep every other export in the file, so the page that renders it keeps working.
- The pasted design code is ${described}. Treat it as the exact visual reference — text, colours, fonts, font sizes, spacing, radii, borders, shadows, images — but rebuild it with normal flow layout (flex/grid) so it is responsive, written the way the rest of this file is written.
- Use the design's text and structure. Where the current section wires in real data (props, imported data, links, handlers), keep that wiring on the matching element of the new design.
- \`<svg data-figma-asset="N" />\` stands for a piece of vector artwork from the design. Copy each one you use exactly as written, and size or position it with a wrapper element; it is swapped back for the real SVG afterwards.
- The export's global style block resets html/body for a standalone page. Do not carry those resets into the section; bring over only what it needs, such as a font import.
- Image paths starting with /figma/ are already in the project's public folder.
- \`${MISSING_IMAGE}\` marks an image whose pixels could not be fetched. Never reference it: draw a neutral placeholder of the same size and shape in its place (for example a muted background box).

Current file (${section.file}):
\`\`\`
${current}
\`\`\`

Pasted design (${framework.label}):
\`\`\`
${compact}
\`\`\``;

  let reply: string;
  try {
    reply = await generateLlmText({
      system: SYSTEM,
      prompt,
      // Only fall back to the visitor's own key when the server has none.
      apiKey: hasGlobalKey ? undefined : userApiKey,
      onUsage: (usage) => addUsage(projectId, usage),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "The model call failed.",
      },
      { status: 502 },
    );
  }

  const next = codeOf(reply).replace(
    ASSET,
    (tag, index) => assets[Number(index)] ?? tag,
  );
  // A reply without the component would take the page down with it; the file stays as it was.
  if (!new RegExp(`\\b${section.name}\\b`).test(next)) {
    return NextResponse.json(
      {
        error: `The model did not return a \`${section.name}\` component; nothing was changed.`,
      },
      { status: 502 },
    );
  }

  await writeFile(resolveInApp(projectId, section.file)!, next);
  return NextResponse.json({
    ok: true,
    name: section.name,
    file: section.file,
    // The section's element id, so the preview can scroll to what changed.
    anchor: next.match(/\bid=["']([\w-]+)["']/)?.[1] ?? null,
    missingImages,
    imageError,
  });
}
