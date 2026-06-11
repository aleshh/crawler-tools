#!/usr/bin/env node
import * as cheerio from "cheerio";
import { createWriteStream } from "node:fs";

const startUrl = "https://pitchfork.com/reviews/albums/";
const outputFile = "pitchfork-review-urls.txt";

const seen = new Set();
const out = createWriteStream(outputFile, { flags: "w" });

let pagesRead = 0;
let urlsWritten = 0;

async function crawl(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 personal crawler" },
  });

  if (!res.ok) throw new Error(`${res.status} ${url}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  pagesRead++;

  $('a[href^="/reviews/albums/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href || href === "/reviews/albums/") return;

    const full = new URL(href, startUrl).href;

    if (!seen.has(full)) {
      seen.add(full);
      out.write(full + "\n");
      urlsWritten++;
    }
  });

  console.error(`${pagesRead} pages read, ${urlsWritten} review URLs written`);

  const nextHref = $("a")
    .filter((_, a) => $(a).text().trim() === "Next Page")
    .attr("href");

  if (nextHref) {
    await new Promise((r) => setTimeout(r, 1000));
    await crawl(new URL(nextHref, startUrl).href);
  }
}

try {
  await crawl(startUrl);
} finally {
  out.end();
}

