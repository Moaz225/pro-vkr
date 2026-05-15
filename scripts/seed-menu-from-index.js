/**
 * One-time migration: parse static menu cards from index.html and insert into PostgreSQL Product.
 *
 * Usage (from repo root, DATABASE_URL in .env):
 *   node scripts/seed-menu-from-index.js
 *   node scripts/seed-menu-from-index.js --force   # re-run even if catalog looks already seeded
 *
 * Parses `scripts/menu-seed-source.html` when present (snapshot of static menu),
 * else `index.html`, so seeding still works after the live menu is rendered from the API.
 *
 * Verify: GET /api/products should return the full catalog.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { PrismaClient, Prisma } = require('@prisma/client');

const DEFAULT_IMAGE_URL =
  'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=800&q=60';

const TOP_SECTION_IDS = ['coffee', 'seasonal', 'tea', 'cocoa', 'fresh'];

function firstPriceNumber(text) {
  const m = String(text || '').match(/\d+/);
  return m ? parseInt(m[0], 10) : 0;
}

function parseIndexHtml(html) {
  const $ = cheerio.load(html);
  const rows = [];

  for (const sectionId of TOP_SECTION_IDS) {
    const $section = $(`section#${sectionId}`);
    $section.find('.menu-grid .menu-card').each((_, el) => {
      const $card = $(el);
      const name = $card.find('.item-name').first().text().trim();
      const price = firstPriceNumber($card.find('.item-price').first().text());
      const description = $card.find('.item-description').text().replace(/\s+/g, ' ').trim() || '—';
      if (!name || !price) return;
      rows.push({
        name: name.slice(0, 200),
        description: description.slice(0, 4000),
        price,
        category: sectionId,
        imageUrl: DEFAULT_IMAGE_URL
      });
    });
  }

  $('#meals .meal-category').each((_, catEl) => {
    const $cat = $(catEl);
    const category = String($cat.attr('id') || '').trim();
    if (!category.startsWith('meals-')) return;

    $cat.find('.meal-item').each((_, itemEl) => {
      const $item = $(itemEl);
      const $nameBlock = $item.find('.meal-name').first();
      const price = firstPriceNumber($nameBlock.find('.meal-price').first().text());
      const name = $nameBlock
        .clone()
        .children()
        .remove()
        .end()
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      const description =
        $item
          .find('.meal-description')
          .map((__, d) => $(d).text().replace(/\s+/g, ' ').trim())
          .get()
          .filter(Boolean)
          .join(' ') || '—';
      if (!name || !price) return;
      rows.push({
        name: name.slice(0, 200),
        description: description.slice(0, 4000),
        price,
        category,
        imageUrl: DEFAULT_IMAGE_URL
      });
    });
  });

  return rows;
}

async function main() {
  const force = process.argv.includes('--force');
  const snapshotPath = path.join(__dirname, 'menu-seed-source.html');
  const indexPath = fs.existsSync(snapshotPath)
    ? snapshotPath
    : path.join(__dirname, '..', 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.error('Missing menu source HTML at', indexPath);
    process.exit(1);
  }

  const html = fs.readFileSync(indexPath, 'utf8');
  const data = parseIndexHtml(html);
  if (data.length === 0) {
    console.error('No menu rows parsed from index.html');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.product.count();
    if (!force && existing >= Math.floor(data.length * 0.9)) {
      console.error(
        `Abort: Product table already has ${existing} rows (parsed ${data.length} from index). Re-run with --force to insert again.`
      );
      process.exit(1);
    }

    const prismaRows = data.map((r) => ({
      name: r.name,
      description: r.description,
      price: new Prisma.Decimal(r.price.toFixed(2)),
      category: r.category,
      imageUrl: r.imageUrl.slice(0, 2048),
      isAvailable: true
    }));

    const res = await prisma.product.createMany({ data: prismaRows });
    console.log('createMany count:', res.count, '(expected', prismaRows.length, ')');
    const total = await prisma.product.count();
    console.log('Total Product rows now:', total);
    console.log('Verify with: GET /api/products');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
