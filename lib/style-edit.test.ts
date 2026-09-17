import assert from "node:assert/strict";
import { test } from "node:test";
import { describeChanges, editClasses, validChange } from "./style-edit";

const edit = (classes: string, prop: string, value: string | null) =>
  editClasses(classes, [{ prop, value } as never]).classes;

test("replaces the utility that sets the property and leaves the rest", () => {
  assert.equal(edit("flex px-4 py-2", "paddingX", "24px"), "flex py-2 px-6");
  assert.equal(
    edit("font-bold text-lg", "fontWeight", "500"),
    "text-lg font-medium",
  );
  assert.equal(
    edit("rounded-lg border", "radius", "12px"),
    "border rounded-[12px]",
  );
  assert.equal(edit("rounded-md", "radius", "9999px"), "rounded-full");
  assert.equal(edit("shadow-sm", "shadow", "lg"), "shadow-lg");
  assert.equal(edit("opacity-50", "opacity", "0.37"), "opacity-[0.37]");
  assert.equal(edit("opacity-50", "opacity", "0.8"), "opacity-80");
  assert.equal(edit("object-cover", "objectFit", "contain"), "object-contain");
  assert.equal(
    edit("flex flex-col gap-2 space-y-4", "gap", "13px"),
    "flex flex-col gap-[13px]",
  );
  assert.equal(edit("flex flex-col", "direction", "row"), "flex flex-row");
  assert.equal(
    edit("tracking-tight", "letterSpacing", "0.02em"),
    "tracking-[0.02em]",
  );
  assert.equal(edit("leading-7", "lineHeight", "1.25"), "leading-tight");
  assert.equal(
    edit("font-sans", "fontFamily", "Open Sans"),
    "font-['Open_Sans']",
  );
});

test("scale names only where they are exact", () => {
  assert.equal(edit("", "paddingY", "1px"), "py-px");
  assert.equal(edit("", "paddingY", "13px"), "py-[13px]");
  assert.equal(edit("", "fontSize", "18px"), "text-lg");
  assert.equal(edit("", "fontSize", "15px"), "text-[15px]");
});

test("size, colour and alignment share the text- prefix without touching each other", () => {
  const classes = "text-center text-sm text-muted-foreground text-balance";
  assert.equal(
    edit(classes, "color", "#49FF8C"),
    "text-center text-sm text-balance text-[#49FF8C]",
  );
  assert.equal(
    edit(classes, "textAlign", "left"),
    "text-sm text-muted-foreground text-balance text-left",
  );
  assert.equal(
    edit("text-[#fff] text-[14px]", "fontSize", "20px"),
    "text-[#fff] text-xl",
  );
  assert.equal(
    edit("text-[#fff] text-[14px]", "color", "#000"),
    "text-[14px] text-[#000]",
  );
});

test("a named size keeps its line height when the size becomes arbitrary", () => {
  assert.equal(
    edit("text-5xl", "fontSize", "52px"),
    "leading-none text-[52px]",
  );
  assert.equal(edit("text-5xl", "fontSize", "60px"), "text-6xl");
  assert.equal(
    edit("text-5xl leading-tight", "fontSize", "52px"),
    "leading-tight text-[52px]",
  );
  assert.equal(edit("text-sm/6", "fontSize", "15px"), "leading-6 text-[15px]");
  assert.equal(
    edit("text-sm/6", "lineHeight", "1.5"),
    "text-sm leading-normal",
  );
});

test("p-4 splits when one axis changes", () => {
  assert.equal(edit("p-4", "paddingX", "32px"), "py-4 px-8");
  assert.equal(edit("p-4 pl-2", "paddingY", "0px"), "pl-2 px-4 py-0");
  assert.equal(
    editClasses("p-4", [
      { prop: "paddingX", value: "8px" },
      { prop: "paddingY", value: "4px" },
    ]).classes,
    "px-2 py-1",
  );
});

test("borders: width, colour and style are told apart", () => {
  const classes = "border border-border border-dashed border-t-4";
  assert.equal(
    edit(classes, "borderWidth", "2px"),
    "border-border border-dashed border-t-4 border-2",
  );
  assert.equal(
    edit(classes, "borderColor", "#ff0000"),
    "border border-dashed border-t-4 border-[#ff0000]",
  );
  assert.equal(
    edit(classes, "borderWidth", "0px"),
    "border-border border-dashed border-0",
  );
  assert.equal(edit("", "borderWidth", "1px"), "border");
});

test("background colour leaves size, position and gradients alone", () => {
  assert.equal(
    edit(
      "bg-cover bg-center bg-gradient-to-r bg-white bg-[url(/a.png)]",
      "background",
      "#111111",
    ),
    "bg-cover bg-center bg-gradient-to-r bg-[url(/a.png)] bg-[#111111]",
  );
});

test("variants are left alone and reported", () => {
  const result = editClasses("px-4 md:px-8 hover:bg-primary/90", [
    { prop: "paddingX", value: "8px" },
  ]);
  assert.equal(result.classes, "md:px-8 hover:bg-primary/90 px-2");
  assert.deepEqual(result.shadowedBy, ["md:px-8"]);
});

test("the important form of the replaced utility is kept", () => {
  assert.equal(edit("!px-4", "paddingX", "8px"), "!px-2");
  assert.equal(edit("px-4!", "paddingX", "8px"), "px-2!");
});

test("null removes, and the same change twice is the same as once", () => {
  assert.equal(edit("shadow-lg flex", "shadow", null), "flex");
  const once = edit("p-4 text-sm", "paddingX", "10px");
  assert.equal(edit(once, "paddingX", "10px"), once);
});

test("only values that are safe inside a class string pass", () => {
  assert.ok(validChange({ prop: "color", value: "#49FF8C" }));
  assert.ok(validChange({ prop: "shadow", value: null }));
  assert.ok(!validChange({ prop: "color", value: 'red"] onClick="' }));
  assert.ok(!validChange({ prop: "fontFamily", value: "Inter'] ${x}" }));
  assert.ok(!validChange({ prop: "fontSize", value: "12px; x" }));
  assert.ok(!validChange({ prop: "zIndex", value: "1" }));
  assert.ok(!validChange({ prop: "shadow", value: "toString" }));
});

test("changes read as an instruction", () => {
  assert.match(
    describeChanges([{ prop: "paddingX", value: "12px" }]),
    /horizontal padding 12px/,
  );
});
