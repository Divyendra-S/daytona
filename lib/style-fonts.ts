/**
 * The fonts the inspector offers, and how one gets into a project.
 *
 * A short list rather than the whole Google catalogue: each family is listed with weights it
 * really has, because Google Fonts fails the whole request when one asked-for weight is missing
 * (see `fontUrls` in `lib/figma/figma-paste.ts`). A project gets a family as one `@import` line at
 * the very top of its global stylesheet — above `@import "tailwindcss"`, since a remote import
 * placed after other rules is dropped — and the element gets `font-['Family']`.
 */

const FONTS: Record<string, string> = {
  Inter: "100..900",
  Geist: "100..900",
  Roboto: "400;500;700",
  "Open Sans": "300..800",
  Montserrat: "100..900",
  Poppins: "300;400;500;600;700",
  Lato: "400;700",
  Nunito: "200..1000",
  Raleway: "100..900",
  "Work Sans": "100..900",
  "DM Sans": "400;500;700",
  Manrope: "200..800",
  "Space Grotesk": "300..700",
  "Plus Jakarta Sans": "200..800",
  Outfit: "100..900",
  Sora: "100..800",
  Figtree: "300..900",
  Oswald: "200..700",
  "Bebas Neue": "400",
  "Playfair Display": "400..900",
  Lora: "400..700",
  Merriweather: "400;700",
  "Cormorant Garamond": "400;500;600;700",
  "DM Serif Display": "400",
  "Instrument Serif": "400",
  "JetBrains Mono": "100..800",
  "Space Mono": "400;700",
};

export const FONT_FAMILIES = Object.keys(FONTS);

export const isOfferedFont = (family: string) =>
  Object.prototype.hasOwnProperty.call(FONTS, family);

export const fontHref = (family: string) =>
  `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${FONTS[family]}&display=swap`;

/** Where a project's global stylesheet usually is, in the order tried. */
export const GLOBAL_STYLESHEETS = [
  "app/globals.css",
  "src/app/globals.css",
  "styles/globals.css",
  "src/styles/globals.css",
];

/** The stylesheet with the family imported on its first line, or unchanged if it already is. */
export const withFontImport = (css: string, family: string) =>
  css.includes(`family=${family.replace(/ /g, "+")}:`)
    ? css
    : `@import url("${fontHref(family)}");\n${css}`;
