#!/usr/bin/env node
/**
 * Semi-auto procurement crawler
 *
 * Usage:
 *   node tools/semi_crawl.mjs
 *   node tools/semi_crawl.mjs --dry-run
 *   node tools/semi_crawl.mjs --timeout=15000
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const procurementPath = path.join(rootDir, "data", "procurement.json");
const outputPath = path.join(rootDir, "data", "procurement_scan.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const timeoutMsArg = args.find((a) => a.startsWith("--timeout="));
const timeoutMs = timeoutMsArg ? Number(timeoutMsArg.split("=")[1]) : 12000;

const CHANNEL_SHOPS = {
  akiba: ["akizuki", "marutsu"],
  online: ["switch_science", "amazon", "marutsu"],
};

const OUT_PATTERNS = [
  /在庫切れ/u,
  /売り切れ/u,
  /欠品/u,
  /取扱終了/u,
  /販売終了/u,
  /入荷未定/u,
  /sold\s*out/i,
  /out\s*of\s*stock/i,
];

const IN_PATTERNS = [
  /在庫あり/u,
  /在庫有/u,
  /販売中/u,
  /注文可能/u,
  /購入可能/u,
  /カートに入れる/u,
  /即納/u,
  /add\s*to\s*cart/i,
  /in\s*stock/i,
];

const MAYBE_PATTERNS = [/入荷予定/u, /お取り寄せ/u, /取り寄せ/u, /納期/u, /予約/u];

function shopUrl(base, query) {
  return `${base}${encodeURIComponent(query)}`;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyStatus(text) {
  for (const pattern of OUT_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { status: "out", evidence: m[0] };
  }
  for (const pattern of IN_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { status: "in", evidence: m[0] };
  }
  for (const pattern of MAYBE_PATTERNS) {
    const m = text.match(pattern);
    if (m) return { status: "maybe", evidence: m[0] };
  }
  return { status: "unknown", evidence: "" };
}

async function fetchPage(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
      },
    });
    const html = await res.text();
    return { ok: res.ok, statusCode: res.status, html };
  } finally {
    clearTimeout(timer);
  }
}

function aggregateChannel(shopStatuses) {
  const checked = shopStatuses.filter((s) => s.status !== "unknown");
  if (checked.some((s) => s.status === "in")) return "in";
  if (checked.length > 0 && checked.every((s) => s.status === "out")) return "out";
  if (checked.some((s) => s.status === "maybe")) return "maybe";
  return "unknown";
}

async function main() {
  const procurement = JSON.parse(await fs.readFile(procurementPath, "utf8"));
  const shopsById = Object.fromEntries((procurement.shops || []).map((s) => [s.id, s]));

  const scan = {
    generated_at: new Date().toISOString(),
    generated_by: "tools/semi_crawl.mjs",
    timeout_ms: timeoutMs,
    items: [],
  };

  for (const item of procurement.items || []) {
    const perShop = {};

    for (const [shopId, query] of Object.entries(item.queries || {})) {
      const shop = shopsById[shopId];
      if (!shop || !query) continue;

      const url = shopUrl(shop.search_url, query);

      try {
        const res = await fetchPage(url, timeoutMs);
        const text = stripHtml(res.html);
        const cls = classifyStatus(text);
        perShop[shopId] = {
          status: cls.status,
          evidence: cls.evidence,
          http_status: res.statusCode,
          url,
        };
      } catch (err) {
        perShop[shopId] = {
          status: "unknown",
          evidence: "",
          error: String(err?.message || err),
          url,
        };
      }
    }

    const akibaStatuses = CHANNEL_SHOPS.akiba
      .map((id) => perShop[id])
      .filter(Boolean)
      .map((s) => ({ status: s.status }));
    const onlineStatuses = CHANNEL_SHOPS.online
      .map((id) => perShop[id])
      .filter(Boolean)
      .map((s) => ({ status: s.status }));

    scan.items.push({
      id: item.id,
      label: item.label,
      akiba: {
        status: aggregateChannel(akibaStatuses),
        checked_shops: CHANNEL_SHOPS.akiba.filter((id) => perShop[id]).length,
      },
      online: {
        status: aggregateChannel(onlineStatuses),
        checked_shops: CHANNEL_SHOPS.online.filter((id) => perShop[id]).length,
      },
      shops: perShop,
    });
  }

  if (!dryRun) {
    await fs.writeFile(outputPath, JSON.stringify(scan, null, 2) + "\n", "utf8");
  }

  console.log(`scan generated: ${scan.generated_at}`);
  console.log(`output: ${dryRun ? "(dry-run, not saved)" : outputPath}`);
  for (const item of scan.items) {
    console.log(
      `- ${item.id}: akiba=${item.akiba.status} (${item.akiba.checked_shops} shops), online=${item.online.status} (${item.online.checked_shops} shops)`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
