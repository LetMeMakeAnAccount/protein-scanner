// Generates src/data/marketplace-seed.json from Open Food Facts.
// Run: node scripts/seed-marketplace.mjs
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const categories = [
  "yogurts", "greek-yogurts", "cottage-cheeses", "cheeses", "milks",
  "protein-bars", "protein-powders", "cereals", "oats", "breads",
  "chickens", "eggs", "tunas", "salmons", "beans", "lentils",
  "peanut-butters", "nuts", "tofu", "hummus",
];

const UA = "ProteinScanner/0.1 (hackathon prototype)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchCategory(category) {
  const url = `https://world.openfoodfacts.org/api/v2/search?categories_tags=en:${category}` +
    `&fields=code,product_name,brands,nutriments,quantity,countries_tags` +
    `&page_size=60&sort_by=popularity_key`;
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`${category}: HTTP ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.products) ? body.products : [];
}

function gramsFromQuantity(text) {
  if (typeof text !== "string") return null;
  const lower = text.toLowerCase();
  // "4 x 125 g (500 g)" -> prefer the parenthesised total.
  const parenthesised = lower.match(/\((\d+(?:\.\d+)?)\s*(kg|g|oz|lb|lbs)\)/);
  // "80 x 31 g" -> total, not the single sachet.
  const multipack = lower.match(/(\d+)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(kg|g|oz|lb|lbs)\b/);
  const single = lower.match(/(\d+(?:\.\d+)?)\s*(kg|g|oz|lb|lbs|ml|l)\b/);
  const match = parenthesised ?? multipack ?? single;
  if (!match) return null;
  const amount = parenthesised ? Number(match[1])
    : multipack ? Number(match[1]) * Number(match[2])
    : Number(match[1]);
  const unit = match[parenthesised ? 2 : multipack ? 3 : 2];
  const factor = { kg: 1000, g: 1, oz: 28.349523125, lb: 453.59237, lbs: 453.59237, ml: 1, l: 1000 }[unit];
  if (!Number.isFinite(amount) || amount <= 0 || !factor) return null;
  const grams = Math.round(amount * factor);
  if (unit === "ml" || unit === "l") return null;
  // Single sachets and sample sizes make per-package ratios meaningless.
  return grams < 40 ? null : grams;
}

const byCode = new Map();
for (const category of categories) {
  try {
    const products = await fetchCategory(category);
    for (const product of products) {
      const code = String(product.code ?? "").trim();
      const name = String(product.product_name ?? "").trim();
      const brand = String(product.brands ?? "").split(",")[0].trim();
      const protein = Number(product.nutriments?.proteins_100g);
      const kcal = Number(product.nutriments?.["energy-kcal_100g"]);
      if (!/^\d{8,14}$/.test(code) || !name || name.length > 90) continue;
      if (!Number.isFinite(protein) || protein < 0 || protein > 100) continue;
      if (!Number.isFinite(kcal) || kcal <= 0 || kcal > 900) continue;
      if (byCode.has(code)) continue;
      byCode.set(code, {
        code,
        name: brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name,
        proteinG: Math.round(protein * 10) / 10,
        kcal: Math.round(kcal),
        packageGrams: gramsFromQuantity(product.quantity),
        packageLabel: typeof product.quantity === "string" ? product.quantity.slice(0, 40) : null,
        country: Array.isArray(product.countries_tags) && product.countries_tags.includes("en:united-states") ? "US" : null,
      });
    }
    console.log(`${category}: ${products.length} fetched, ${byCode.size} kept`);
  } catch (error) {
    console.error(`${category}: ${error.message}`);
  }
  await sleep(1200);
}

const foods = [...byCode.values()]
  .sort((a, b) => (b.country === "US") - (a.country === "US") || b.proteinG - a.proteinG)
  .slice(0, 250);

const out = resolve("src/data/marketplace-seed.json");
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), source: "Open Food Facts (ODbL)", foods }, null, 1));
console.log(`wrote ${foods.length} foods to ${out}`);
