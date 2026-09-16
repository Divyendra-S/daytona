import { NextResponse } from "next/server";
import { excludeFromGit } from "@/lib/git-exclude";
import { authorizeProject } from "@/lib/project-access";
import { writeProjectFile } from "@/lib/project-files";

/**
 * The taste rules a design critique scores against, written into the project for the agent.
 *
 * A file rather than the chat message or the system prompt: the message stays readable in the
 * thread, and every other chat request does not pay for rules it does not use. The DESIGN.md the
 * agent writes from it is the project's own and is committed; the rules file is not.
 */
const RULES_FILE = ".adorable/design-rules.md";

const RULES = `# Design rules

Score each category 1–5. Every issue names a file and what to change.

## 1. Hierarchy
- One clear focal point per section; the eye knows where to start.
- A consistent type scale (ratio ~1.2–1.333); headings step down predictably.
- At most two font families and three weights across the site.

## 2. Spacing & layout
- One spacing scale (4/8px based); no arbitrary one-off values.
- Related items sit closer than unrelated ones — proximity carries meaning.
- A consistent container width and section padding; edges line up on a grid.
- Readable measure: body text 45–75 characters per line.

## 3. Color
- A restrained palette: neutrals plus one accent (at most one secondary).
- Contrast meets WCAG AA: 4.5:1 for body text, 3:1 for large text and UI.
- Colors are defined once as tokens (CSS variables / theme), not repeated raw hex values.

## 4. Surfaces
- Radii, borders and shadows come from a small set of tokens, used consistently.
- Elevation means something: shadows only where a surface sits above another.

## 5. Components
- The same component looks the same everywhere: buttons share height, padding, radius and states.
- Every interactive element has hover, active and :focus-visible states.
- Tap targets are at least 44×44px on touch.

## 6. Motion
- Motion explains a change (enter, exit, state); none is decoration for its own sake.
- 150–300ms for UI, ease-out for entrances; nothing blocks interaction.
- prefers-reduced-motion removes non-essential movement.

## 7. Responsiveness
- No horizontal scroll at 375px; layouts reflow rather than shrink.
- Images keep their aspect ratio; type scales down gracefully.

## 8. Imagery & copy
- Images share aspect ratios and treatment within a section; every image has meaningful alt text.
- Headings are short and specific; each section has at most one primary call to action.

## 9. Accessibility
- Semantic landmarks and heading order (one h1, no skipped levels).
- Labels on every form field; visible focus; nothing conveyed by color alone.
`;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;
  if (!(await authorizeProject(projectId))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await writeProjectFile(projectId, RULES_FILE, RULES);
  await excludeFromGit(projectId, ".adorable/");
  return NextResponse.json({ ok: true, rulesFile: RULES_FILE });
}
