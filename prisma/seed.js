/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { PrismaClient } = require("@prisma/client");

function parseFirstIntPrice(priceText) {
  const m = String(priceText || "").match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function guessCategoryFromContext(html, pos) {
  // Heuristic: try to find the nearest surrounding section id or meal-category id.
  const pre = html.slice(0, pos);

  let category = null;

  const sectionMatches = [...pre.matchAll(/<section[^>]*id="([^"]+)"[^>]*>/g)];
  if (sectionMatches.length > 0) {
    category = sectionMatches[sectionMatches.length - 1][1];
  }

  const mealMatches = [...pre.matchAll(/<div[^>]*class="meal-category"[^>]*id="([^"]+)"[^>]*>/g)];
  if (mealMatches.length > 0) {
    category = mealMatches[mealMatches.length - 1][1];
  }

  return category || "menu";
}

function foodTypeFromCategory(category, name) {
  const c = String(category || "").toLowerCase();
  const n = String(name || "").toLowerCase();

  // Pizza
  if (c.includes("meals-pizza") || n.includes("пицц")) return "pizza";

  // Salad
  if (c.includes("meals-salads") || n.includes("салат")) return "salad";

  // Soups
  if (c.includes("meals-soups") || n.includes("суп")) return "soup";

  // Pasta
  if (c.includes("meals-pasta") || n.includes("паста")) return "pasta";

  // Desserts (cakes, eclairs, cheesecakes, cookies, pies, rolls, etc.)
  if (
    c.includes("meals-desserts") ||
    c.includes("meals-pancakes") ||
    n.includes("торт") ||
    n.includes("пирог") ||
    n.includes("эклер") ||
    n.includes("чизкейк") ||
    n.includes("печень") ||
    n.includes("рулет")
  ) {
    return "dessert";
  }

  // Cheesecake / curd items
  if (c.includes("meals-curd") || n.includes("сырник") || n.includes("творог")) return "cheesecake";

  // Breakfast
  if (c.includes("meals-breakfasts") || n.includes("завтрак")) return "breakfast";

  // Toasts / sandwiches / club sandwiches
  if (c.includes("meals-toasts") || n.includes("тост") || n.includes("сэндвич") || n.includes("хот-дог")) return "sandwich";

  // Drinks / coffee-like
  if (c.includes("coffee") || c.includes("seasonal") || c.includes("tea") || c.includes("cocoa") || c.includes("fresh")) {
    return "coffee";
  }

  // Fallback
  return "food";
}

function imageUrlForFoodType(foodType, seedText) {
  // Stable and fast: picsum.photos supports arbitrary seed strings.
  // The user requested the pattern:
  //   picsum.photos/seed/<food-type>-<name>/800/600
  // We percent-encode to safely support Cyrillic/spaces in the seed.
  const seed = `${foodType}-${seedText}`;
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/800/600`;
}

async function main() {
  const prisma = new PrismaClient();

  const indexPath = path.join(__dirname, "..", "index.html");
  const html = fs.readFileSync(indexPath, "utf8");

  // Collect products from the current menu markup.
  // Note: UI contains both `.menu-card` (coffee-like) and `.meal-item` blocks.
  const productsByKey = new Map(); // key -> product

  // 1) Coffee-style cards: <span class="item-name">NAME</span><span class="item-price">PRICE₽</span>
  const itemNamePriceRe = /<span\s+class="item-name">([^<]+)<\/span>\s*<span\s+class="item-price">([^<]+)<\/span>/gim;
  for (const match of html.matchAll(itemNamePriceRe)) {
    const name = String(match[1] || "").trim();
    const priceText = match[2];
    const price = parseFirstIntPrice(priceText);
    if (!name || price == null) continue;

    // Best-effort category guessing.
    const pos = match.index != null ? match.index : 0;
    const category = guessCategoryFromContext(html, pos);
    const foodType = foodTypeFromCategory(category, name);

    const key = `${name}__${price}__${category}`;
    if (productsByKey.has(key)) continue;

    productsByKey.set(key, {
      name,
      description: "",
      price,
      category,
      imageUrl: imageUrlForFoodType(foodType, `${name}-${price}-${category}`),
    });
  }

  // 2) Meal items: <div class="meal-name">NAME<span class="meal-price">PRICE₽</span></div>
  const mealNamePriceRe =
    /<div\s+class="meal-name">([\s\S]*?)<span\s+class="meal-price">([^<]+)<\/span>\s*<\/div>/gim;
  for (const match of html.matchAll(mealNamePriceRe)) {
    // `meal-name` may contain nested nodes; keep only the plain text part before price span.
    const nameRaw = String(match[1] || "");
    const name = nameRaw.replace(/<[^>]+>/g, "").trim();
    const priceText = match[2];
    const price = parseFirstIntPrice(priceText);
    if (!name || price == null) continue;

    const pos = match.index != null ? match.index : 0;
    const category = guessCategoryFromContext(html, pos);
    const foodType = foodTypeFromCategory(category, name);

    const key = `${name}__${price}__${category}`;
    if (productsByKey.has(key)) continue;

    productsByKey.set(key, {
      name,
      description: "",
      price,
      category,
      imageUrl: imageUrlForFoodType(foodType, `${name}-${price}-${category}`),
    });
  }

  console.log(`Found ${productsByKey.size} products from index.html markup.`);

  // DEV ONLY: Replace the products table contents.
  await prisma.product.deleteMany();

  const rows = [...productsByKey.values()].map((p) => ({
    ...p,
    // Prisma Decimal from integer is fine.
    imageUrl: p.imageUrl,
  }));

  // Batch insert.
  const chunkSize = 100;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await prisma.product.createMany({ data: chunk });
    console.log(`Seeded ${Math.min(i + chunkSize, rows.length)}/${rows.length}`);
  }

  await prisma.$disconnect();
  console.log("Seed finished.");
}

main().catch(async (e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});

