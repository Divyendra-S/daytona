import assert from "node:assert/strict";
import { test } from "node:test";
import { literalsIn, locate, locateHint, rareTokens } from "./style-locate";

// The starter home page a new project gets (`STARTER_PAGE` in lib/project-runtime.ts).
const STARTER = `export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Your app is running</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        This is the starter home page. Don't worry about it.
      </p>
    </main>
  );
}
`;
const starter = { path: "app/page.tsx", content: STARTER };

const BUTTON = `const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium",
  { variants: { variant: { default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/90" } } },
);
`;
const button = { path: "components/ui/button.tsx", content: BUTTON };

const h1 = {
  tag: "h1",
  classes: "text-2xl font-semibold tracking-tight",
  text: "Your app is running",
  page: "/",
};

test("literals: strings, comments, and an apostrophe in JSX text", () => {
  const values = literalsIn(STARTER).map((literal) => literal.value);
  assert.deepEqual(values, [
    "flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center",
    "text-2xl font-semibold tracking-tight",
    "max-w-md text-sm text-muted-foreground",
  ]);
  assert.deepEqual(
    literalsIn(`// "no"\n/* 'no' */ const a = "yes";`).map((l) => l.value),
    ["yes"],
  );
});

test("the exact class string in the page's file", () => {
  const found = locate([starter, button], h1);
  assert.ok(found.ok);
  assert.equal(found.file, "app/page.tsx");
  assert.equal(found.line, 4);
  assert.equal(STARTER.slice(found.start, found.end), h1.classes);
});

test("a cn() call is one element: the widest literal is the one edited", () => {
  const source = `<div className={cn("rounded-xl border p-6 shadow-sm", active && "ring-2")}>Plan</div>`;
  const found = locate([{ path: "components/card.tsx", content: source }], {
    tag: "div",
    classes: "rounded-xl border p-6 shadow-sm ring-2",
    text: "Plan",
    page: "/",
  });
  assert.ok(found.ok);
  assert.equal(found.literal, "rounded-xl border p-6 shadow-sm");
  assert.deepEqual(found.warnings, ["conditional"]);
});

test("a shadcn button: the call site's classes, never the cva", () => {
  const page = {
    path: "app/page.tsx",
    content: `<Button className="mt-6 w-full">Explore Gallery</Button>`,
  };
  const rendered =
    "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium bg-primary text-primary-foreground shadow-xs hover:bg-primary/90";
  const found = locate([page, button], {
    tag: "button",
    classes: `${rendered} mt-6 w-full`,
    text: "Explore Gallery",
    page: "/",
  });
  assert.ok(found.ok);
  assert.equal(found.literal, "mt-6 w-full");

  const bare = locate([page, button], {
    tag: "button",
    classes: rendered,
    text: "Explore Gallery",
    page: "/",
  });
  assert.deepEqual(bare.ok ? null : bare.reason, "shared-component");
});

test("refusals", () => {
  const reason = (result: ReturnType<typeof locate>) =>
    result.ok ? null : result.reason;
  assert.equal(reason(locate([starter], { ...h1, classes: "" })), "no-class");
  assert.equal(
    reason(locate([starter], { ...h1, classes: "grid grid-cols-3 gap-8" })),
    "not-found",
  );

  const twice = `<li className="flex gap-2 text-sm">{a}</li>\n<li className="flex gap-2 text-sm">{b}</li>`;
  assert.equal(
    reason(
      locate([{ path: "app/page.tsx", content: twice }], {
        tag: "li",
        classes: "flex gap-2 text-sm",
        text: "",
        page: "/",
      }),
    ),
    "ambiguous",
  );

  const template =
    "<div className={`flex gap-2 ${wide ? 'w-full' : 'w-64'}`} />";
  assert.equal(
    reason(
      locate([{ path: "app/page.tsx", content: template }], {
        tag: "div",
        classes: "flex gap-2 w-full",
        text: "",
        page: "/",
      }),
    ),
    "dynamic",
  );
});

test("the same literal twice: the element's text next to one of them decides", () => {
  const twice = `<li className="flex gap-2 text-sm">Fast delivery</li>\n<li className="flex gap-2 text-sm">Free returns</li>`;
  const found = locate([{ path: "app/page.tsx", content: twice }], {
    tag: "li",
    classes: "flex gap-2 text-sm",
    text: "Free returns",
    page: "/",
  });
  assert.ok(found.ok);
  assert.equal(found.line, 2);
});

test("hint: only while the literal is still there exactly once", () => {
  assert.ok(locateHint(starter, h1.classes)?.ok);
  assert.equal(locateHint(starter, "text-3xl"), null);
  assert.equal(
    locateHint({ path: "a.tsx", content: `"x y" "x y"` }, "x y"),
    null,
  );
});

test("rare tokens: arbitrary values first, then the longest", () => {
  assert.deepEqual(
    rareTokens("flex p-4 text-[#49FF8C] text-muted-foreground", 2),
    ["text-[#49FF8C]", "text-muted-foreground"],
  );
});
