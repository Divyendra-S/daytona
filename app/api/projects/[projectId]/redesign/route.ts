import { NextResponse } from "next/server";
import { excludeFromGit } from "@/lib/git-exclude";
import { authorizeProject } from "@/lib/project-access";
import { writeProjectFile } from "@/lib/project-files";

/**
 * A live page, saved into the project for the chat agent to redesign.
 *
 * Fetched here rather than by the agent with curl: a modern page is mostly scripts, styles and
 * inline SVG, and none of that helps a redesign — stripped, the model reads the content and
 * structure at a fraction of the tokens. Saved under `.adorable/`, a dot folder the build and
 * TypeScript never pick up, and kept out of the project's commits.
 */

const MAX_BYTES = 5_000_000;
// ponytail: cap on what the agent is handed; very long pages lose their tail, chunk if that matters.
const MAX_SAVED_CHARS = 400_000;

const clean = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|template|iframe|canvas)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, "<svg></svg>")
    .replace(
      /\s(?:on[a-z]+|style|srcset|sizes|nonce|integrity|crossorigin|data-[\w-]+)=("[^"]*"|'[^']*')/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .trim();

const titleOf = (html: string) =>
  html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { url?: string } | null;
  let source: URL;
  try {
    source = new URL(body?.url?.trim() ?? "");
  } catch {
    return NextResponse.json(
      { error: "Enter a full URL, like https://example.com." },
      { status: 400 },
    );
  }
  if (source.protocol !== "http:" && source.protocol !== "https:") {
    return NextResponse.json(
      { error: "Only http and https URLs can be redesigned." },
      { status: 400 },
    );
  }

  let response: Response;
  try {
    response = await fetch(source, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: {
        // Some sites refuse requests without a browser-like agent.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: `Could not reach ${source.host}: ${error instanceof Error ? error.message : String(error)}`,
      },
      { status: 502 },
    );
  }
  if (!response.ok) {
    return NextResponse.json(
      { error: `${source.host} answered ${response.status}.` },
      { status: 502 },
    );
  }
  if (!(response.headers.get("content-type") ?? "").includes("html")) {
    return NextResponse.json(
      { error: "That URL is not an HTML page." },
      { status: 415 },
    );
  }

  const raw = await response.text();
  if (raw.length > MAX_BYTES) {
    return NextResponse.json(
      { error: "That page is too large to redesign." },
      { status: 413 },
    );
  }

  const finalUrl = response.url || source.toString();
  const title = titleOf(raw);
  const cleaned = clean(raw).slice(0, MAX_SAVED_CHARS);
  // An SPA shell with no server-rendered content leaves the agent nothing to work from.
  if (cleaned.replace(/<[^>]+>/g, "").trim().length < 200) {
    return NextResponse.json(
      {
        error:
          "That page renders its content with JavaScript, so its HTML has almost nothing to redesign from. Capture it with the Chrome extension and paste it into the canvas instead.",
      },
      { status: 422 },
    );
  }

  const host = new URL(finalUrl).hostname.replace(/[^a-z0-9.-]/gi, "");
  const file = `.adorable/redesign/${host}-${Date.now().toString(36)}.html`;
  await writeProjectFile(
    projectId,
    file,
    `<!-- Source: ${finalUrl} — fetched ${new Date().toISOString()}; scripts, styles and SVG bodies stripped. Relative URLs resolve against the source. -->\n${cleaned}\n`,
  );
  await excludeFromGit(projectId, ".adorable/");

  return NextResponse.json({ ok: true, file, url: finalUrl, title });
}
