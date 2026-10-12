// Fills a scaffolded addon-package/addon.json (from `alexa-ai new mcp`) with
// Hearth's endpoint, listing text, policy URLs and image URLs. It patches
// fields by key name wherever the scaffold puts them, so it tolerates
// schema nesting changes; anything it can't place is printed for you to paste.
//
//   node alexa/configure-addon.ts <path/to/addon-package/addon.json> [https://public-url]
import { readFileSync, writeFileSync } from "node:fs";

const [file, urlArg] = process.argv.slice(2);
const base = (urlArg ?? process.env.HEARTH_PUBLIC_URL ?? "").replace(/\/+$/, "");
if (!file || !/^https:\/\//.test(base)) {
  console.error("usage: node alexa/configure-addon.ts <addon.json> <https://your-public-hearth-url>  (or set HEARTH_PUBLIC_URL)");
  process.exit(2);
}
const listing = JSON.parse(readFileSync(new URL("./listing.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(file, "utf8"));
const icon = (size: number) => `${base}/assets/icon-${size}.png`;
const patched = new Set<string>();

type Json = Record<string, unknown> | unknown[];
function walk(node: unknown, path: string[] = []): void {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, [...path, String(i)]));
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const set = (value: unknown, label = k) => ((obj[k] = value), patched.add(label));
    const valueOf = (text: string) => (v && typeof v === "object" && "value" in (v as object) ? { ...(v as object), value: text } : text);
    if (k === "uri" && path.slice(-2).join(".") === "endpoints.default") set(`${base}/mcp`, "MCP endpoint uri");
    else if (k === "privacyPolicyUrl") set(`${base}/privacy`);
    else if (k === "termsOfUseUrl") set(`${base}/terms`);
    else if (k === "name" && path.includes("locales")) set(valueOf(listing.name), "name");
    else if (k === "shortDescription") set(valueOf(listing.shortDescription));
    else if (k === "fullDescription") set(valueOf(listing.fullDescription));
    else if (k === "examplePhrases") set(listing.examplePhrases);
    else if (k === "distributionCountries") set(listing.distributionCountries);
    else if (/^\d{2,3}x\d{2,3}$/.test(k) && path.includes("icons")) set(icon(Number(k.split("x")[0])), `icon ${k}`);
    else if (k === "carouselImages" && Array.isArray(v)) set([{ ...(v[0] as object), uri: `${base}/assets/carousel.png`, altText: listing.carouselAltText }], "carouselImages");
    else walk(v, [...path, k]);
  }
}
walk(manifest as Json);
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Patched ${file}:\n  ${[...patched].join("\n  ")}\n`);
const wanted = ["MCP endpoint uri", "privacyPolicyUrl", "termsOfUseUrl", "name", "shortDescription", "fullDescription", "examplePhrases", "carouselImages"];
const missed = wanted.filter((w) => !patched.has(w));
if (missed.length || ![...patched].some((p) => p.startsWith("icon"))) {
  console.log("Couldn't find these fields in the scaffold; paste them by hand:");
  for (const m of missed) console.log(`  ${m}`);
  console.log(`  icons: ${[72, 64, 88, 126, 180, 241].map(icon).join("\n         ")}`);
  console.log(`  carousel (600x900): ${base}/assets/carousel.png`);
}
