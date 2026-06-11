#!/usr/bin/env node
import * as cheerio from "cheerio";
import { createWriteStream } from "node:fs";

let nextUrl = "https://pitchfork.com/reviews/albums/";
const out = createWriteStream("pitchfork-review-urls.txt", { flags: "a" });

const seenPages = new Set();
const seenReviews = new Set();

let pagesRead = 0;
let urlsWritten = 0;

while (nextUrl) {
  if (seenPages.has(nextUrl)) {
    console.error(`Stopping: page loop detected at ${nextUrl}`);
    break;
  }

  seenPages.add(nextUrl);

  const res = await fetch(nextUrl, {
    headers: { "User-Agent": "Mozilla/5.0 personal crawler" },
  });

  if (!res.ok) throw new Error(`${res.status} ${nextUrl}`);

  const html = await res.text();
  const $ = cheerio.load(html);

  pagesRead++;

  $('a[href^="/reviews/albums/"]').each((_, a) => {
    const href = $(a).attr("href");
    if (!href || href === "/reviews/albums/") return;
    if (/\/reviews\/albums\/\?page=/.test(href)) return;

    const full = new URL(href, nextUrl).href;

    if (!seenReviews.has(full)) {
      seenReviews.add(full);
      out.write(full + "\n");
      urlsWritten++;
    }
  });

  console.error(`${pagesRead} pages read, ${urlsWritten} review URLs written`);

  const foundNext = $("a")
    .filter((_, a) => $(a).text().trim() === "Next Page")
    .attr("href");

  nextUrl = foundNext ? new URL(foundNext, nextUrl).href : null;

  await new Promise((r) => setTimeout(r, 1000));
}

out.end();
