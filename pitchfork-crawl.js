#!/usr/bin/env node
import * as cheerio from "cheerio";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

const BASE_URL = "https://pitchfork.com";
const OUTPUT_DIRECTORY = "output";
const DATABASE_PATH = `${OUTPUT_DIRECTORY}/pitchfork.sqlite`;
const SEARCH_QUERIES = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
];
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const ARTIST_SKIPPABLE_STATUSES = new Set([429, ...RETRYABLE_STATUSES]);
const USER_AGENT =
  "Mozilla/5.0 (compatible; PitchforkReviewURLCrawler/2.0; +https://pitchfork.com/)";

function usage() {
  console.error(
    "Usage: pnpm pitchfork:crawl [--delay-ms <milliseconds>] [--verbose]\n" +
      "       pnpm pitchfork:update [--since <YYYY-MM-DD>] [--margin-days <days>] [--delay-ms <milliseconds>] [--verbose]",
  );
}

function parseInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(value)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    delayMs: 1500,
    verbose: false,
    update: false,
    since: null,
    marginDays: 14,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--verbose") {
      options.verbose = true;
      continue;
    }

    if (argument === "--update") {
      options.update = true;
      continue;
    }

    if (argument === "--since") {
      const value = argv[index + 1];
      if (value === undefined || Number.isNaN(Date.parse(value))) {
        throw new Error("--since requires a date such as 2026-06-01");
      }
      options.since = new Date(value);
      index += 1;
      continue;
    }

    if (argument === "--margin-days") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--margin-days requires a value");
      }
      options.marginDays = parseInteger(value, "--margin-days");
      index += 1;
      continue;
    }

    if (argument === "--delay-ms") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--delay-ms requires a value");
      }
      options.delayMs = parseInteger(value, "--delay-ms");
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.delayMs < 0) {
    throw new Error("--delay-ms must be zero or greater");
  }
  if (options.marginDays < 0) {
    throw new Error("--margin-days must be zero or greater");
  }
  if ((options.since || options.marginDays !== 14) && !options.update) {
    throw new Error("--since and --margin-days require --update");
  }

  return options;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMilliseconds(response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) {
    return null;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isInteger(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryAt = Date.parse(retryAfter);
  return Number.isNaN(retryAt) ? null : Math.max(0, retryAt - Date.now());
}

function retryDelayMilliseconds(response, attempt) {
  if (response.status === 429) {
    return (
      retryAfterMilliseconds(response) ??
      Math.min(30_000 * 2 ** attempt, 300_000)
    );
  }

  return 1000 * 2 ** attempt;
}

function tableColumns(database, tableName) {
  return database
    .prepare(`pragma table_info(${tableName})`)
    .all()
    .map(({ name }) => name);
}

function ensureSchema(database) {
  database.transaction(() => {
    const reviewColumns = tableColumns(database, "review_urls");
    if (
      reviewColumns.length > 0 &&
      (!reviewColumns.includes("artist_url") ||
        reviewColumns.includes("source") ||
        reviewColumns.includes("query"))
    ) {
      database.exec(`
        drop table if exists review_urls_new;
        create table review_urls_new (
          url text primary key,
          artist_url text,
          found_at text default current_timestamp
        );
      `);

      const foundAtExpression = reviewColumns.includes("found_at")
        ? "found_at"
        : "current_timestamp";
      database.exec(`
        insert or ignore into review_urls_new (url, artist_url, found_at)
        select url, null, ${foundAtExpression}
        from review_urls;
        drop table review_urls;
        alter table review_urls_new rename to review_urls;
      `);
    }

    const visitedColumns = tableColumns(database, "visited_pages");
    if (
      visitedColumns.length > 0 &&
      (!visitedColumns.includes("kind") || visitedColumns.includes("query"))
    ) {
      database.exec(`
        drop table if exists visited_pages_new;
        create table visited_pages_new (
          url text primary key,
          kind text not null,
          visited_at text default current_timestamp
        );
      `);

      const visitedAtExpression = visitedColumns.includes("visited_at")
        ? "visited_at"
        : "current_timestamp";
      database.exec(`
        insert or ignore into visited_pages_new (url, kind, visited_at)
        select url, 'legacy', ${visitedAtExpression}
        from visited_pages;
        drop table visited_pages;
        alter table visited_pages_new rename to visited_pages;
      `);
    }

    database.exec(`
      create table if not exists artist_urls (
        url text primary key,
        query text not null,
        found_at text default current_timestamp
      );

      create table if not exists review_urls (
        url text primary key,
        artist_url text,
        found_at text default current_timestamp
      );

      create table if not exists visited_pages (
        url text primary key,
        kind text not null,
        visited_at text default current_timestamp
      );

      create table if not exists artist_search_state (
        query text primary key,
        next_url text,
        completed integer not null default 0
      );

      create table if not exists update_runs (
        id integer primary key,
        started_at text not null,
        cutoff text not null,
        completed_at text,
        pages integer not null default 0,
        inserted integer not null default 0
      );
    `);
  })();
}

function normalizeArtistUrl(href, pageUrl) {
  if (!href) {
    return null;
  }

  let url;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }

  if (
    url.origin !== BASE_URL ||
    !/^\/artists\/(?:\d+-)?[a-z0-9][a-z0-9-]*\/?$/.test(url.pathname)
  ) {
    return null;
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

function normalizeReviewUrl(href, pageUrl) {
  if (!href) {
    return null;
  }

  let url;
  try {
    url = new URL(href, pageUrl);
  } catch {
    return null;
  }

  if (
    url.origin !== BASE_URL ||
    !/^\/reviews\/albums\/[^/]+\/?$/.test(url.pathname)
  ) {
    return null;
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

function findNextPage($, pageUrl) {
  const selectors = [
    'a[rel~="next"]',
    'link[rel~="next"]',
    'a[aria-label*="Next" i]',
    'a[data-testid*="next" i]',
  ];

  for (const selector of selectors) {
    const href = $(selector).first().attr("href");
    if (href) {
      return new URL(href, pageUrl).href;
    }
  }

  const href = $("a")
    .filter((_, element) => /^(next|next page)$/i.test($(element).text().trim()))
    .first()
    .attr("href");

  return href ? new URL(href, pageUrl).href : null;
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  usage();
  process.exitCode = 1;
}

if (options) {
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
  const database = new Database(DATABASE_PATH);
  database.pragma("journal_mode = WAL");
  ensureSchema(database);

  const hasVisitedPage = database.prepare(
    "select 1 from visited_pages where url = ?",
  );
  const insertVisitedPage = database.prepare(`
    insert or ignore into visited_pages (url, kind)
    values (?, ?)
  `);
  const upsertVisitedPage = database.prepare(`
    insert into visited_pages (url, kind)
    values (?, ?)
    on conflict(url) do update set kind = excluded.kind
  `);
  const insertArtistUrl = database.prepare(`
    insert or ignore into artist_urls (url, query)
    values (?, ?)
  `);
  const insertReviewUrl = database.prepare(`
    insert or ignore into review_urls (url, artist_url)
    values (?, ?)
  `);
  const countArtists = database.prepare(
    "select count(*) as count from artist_urls",
  );
  const countReviews = database.prepare(
    "select count(*) as count from review_urls",
  );
  const countVisitedPages = database.prepare(
    "select count(*) as count from visited_pages",
  );
  const getSearchState = database.prepare(`
    select next_url, completed
    from artist_search_state
    where query = ?
  `);
  const updateSearchState = database.prepare(`
    insert into artist_search_state (query, next_url, completed)
    values (?, ?, ?)
    on conflict(query) do update set
      next_url = excluded.next_url,
      completed = excluded.completed
  `);
  const getNextArtist = database.prepare(`
    select artist.url
    from artist_urls as artist
    left join visited_pages as visited
      on visited.url = artist.url || 'review/'
    where visited.url is null
    order by artist.url
    limit 1
  `);
  const countCrawledArtists = database.prepare(`
    select count(*) as count
    from artist_urls as artist
    join visited_pages as visited
      on visited.url = artist.url || 'review/'
  `);
  const getNextSkippedArtist = database.prepare(`
    select artist.url as artist_url, visited.url as review_page_url
    from visited_pages as visited
    join artist_urls as artist
      on visited.url = artist.url || 'review/'
    where visited.kind = 'artist-reviews-skipped'
      and visited.url > ?
    order by visited.url
    limit 1
  `);
  const countSkippedArtists = database.prepare(`
    select count(*) as count
    from visited_pages
    where kind = 'artist-reviews-skipped'
  `);

  const storeArtistSearchPage = database.transaction(
    (pageUrl, query, artistUrls, nextUrl) => {
      let inserted = 0;

      for (const artistUrl of artistUrls) {
        inserted += insertArtistUrl.run(artistUrl, query).changes;
      }
      insertVisitedPage.run(pageUrl, "artist-search");
      updateSearchState.run(query, nextUrl, nextUrl ? 0 : 1);

      return inserted;
    },
  );

  const storeArtistReviewPage = database.transaction(
    (pageUrl, artistUrl, reviewUrls, kind) => {
      let inserted = 0;

      for (const reviewUrl of reviewUrls) {
        inserted += insertReviewUrl.run(reviewUrl, artistUrl).changes;
      }
      upsertVisitedPage.run(pageUrl, kind);

      return inserted;
    },
  );

  const storeListingPage = database.transaction((reviewUrls) => {
    let inserted = 0;

    for (const reviewUrl of reviewUrls) {
      inserted += insertReviewUrl.run(reviewUrl, null).changes;
    }

    return inserted;
  });

  let lastRequestStartedAt = 0;

  async function waitForRequestSlot() {
    if (lastRequestStartedAt > 0) {
      const elapsed = Date.now() - lastRequestStartedAt;
      const remaining = options.delayMs - elapsed;
      if (remaining > 0) {
        await sleep(remaining);
      }
    }
    lastRequestStartedAt = Date.now();
  }

  async function fetchWithRetries(
    url,
    allowedStatuses = new Set(),
    returnRetryExhausted = false,
  ) {
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      let response;

      try {
        await waitForRequestSlot();
        response = await fetch(url, {
          headers: {
            Accept: "text/html,application/xhtml+xml",
            "User-Agent": USER_AGENT,
          },
          redirect: "follow",
        });
      } catch (error) {
        if (attempt === 5) {
          throw error;
        }

        const waitMs = 1000 * 2 ** attempt;
        console.error(
          `Request failed for ${url}; retrying in ${waitMs}ms (${error.message})`,
        );
        await sleep(waitMs);
        continue;
      }

      if (response.ok || allowedStatuses.has(response.status)) {
        return response;
      }

      const retryable =
        response.status === 429 || RETRYABLE_STATUSES.has(response.status);

      if (!retryable || attempt === 5) {
        if (
          returnRetryExhausted &&
          attempt === 5 &&
          ARTIST_SKIPPABLE_STATUSES.has(response.status)
        ) {
          return response;
        }
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const waitMs = retryDelayMilliseconds(response, attempt);
      console.error(
        `HTTP ${response.status} for ${url}; retrying in ${waitMs}ms`,
      );
      await sleep(waitMs);
    }

    throw new Error(`Request retries exhausted for ${url}`);
  }

  async function crawlArtists() {
    for (const query of SEARCH_QUERIES) {
      const state = getSearchState.get(query);
      if (state?.completed) {
        if (options.verbose) {
          console.error(`Artist search query=${query} already completed`);
        }
        continue;
      }

      let pageUrl;
      if (state?.next_url) {
        pageUrl = new URL(state.next_url);
      } else {
        pageUrl = new URL("/search/", BASE_URL);
        pageUrl.searchParams.set("q", query);
        pageUrl.searchParams.set("sort", "score");
        pageUrl.searchParams.set("page", "1");
        pageUrl.searchParams.set("content", "musicgroup");
      }

      while (pageUrl) {
        const currentUrl = pageUrl.href;
        const pageNumber =
          Number.parseInt(pageUrl.searchParams.get("page"), 10) || 1;

        if (hasVisitedPage.get(currentUrl)) {
          throw new Error(`Search pagination loop detected at ${currentUrl}`);
        }
        if (options.verbose) {
          console.error(`Fetching ${currentUrl}`);
        }

        const response = await fetchWithRetries(currentUrl);
        const $ = cheerio.load(await response.text());
        const artistUrls = new Set();

        $("a[href]").each((_, element) => {
          const artistUrl = normalizeArtistUrl(
            $(element).attr("href"),
            currentUrl,
          );
          if (artistUrl) {
            artistUrls.add(artistUrl);
          }
        });

        const nextUrl = findNextPage($, currentUrl);
        let parsedNextUrl = null;
        if (nextUrl) {
          parsedNextUrl = new URL(nextUrl);
          if (
            parsedNextUrl.origin !== BASE_URL ||
            parsedNextUrl.pathname !== "/search/" ||
            parsedNextUrl.searchParams.get("q") !== query ||
            parsedNextUrl.searchParams.get("content") !== "musicgroup"
          ) {
            throw new Error(`Refusing unexpected next-page URL: ${nextUrl}`);
          }
        }

        if (artistUrls.size === 0 && nextUrl) {
          throw new Error(
            `Found no artist URLs on paginated search page ${currentUrl}; page was not saved and will be retried`,
          );
        }

        const inserted = storeArtistSearchPage(
          currentUrl,
          query,
          artistUrls,
          nextUrl,
        );
        console.error(
          `Searching artists: query=${query} page=${pageNumber}, ${inserted} new artists, ${countArtists.get().count} total artists`,
        );

        pageUrl = parsedNextUrl;
      }
    }

    let totalArtists = countArtists.get().count;
    let crawledArtists = countCrawledArtists.get().count;
    let artist;

    while ((artist = getNextArtist.get())) {
      const artistUrl = artist.url;
      const reviewPageUrl = new URL("review/", artistUrl).href;

      if (hasVisitedPage.get(reviewPageUrl)) {
        throw new Error(`Artist review page loop detected at ${reviewPageUrl}`);
      }
      if (options.verbose) {
        console.error(`Fetching ${reviewPageUrl}`);
      }

      const reviewUrls = new Set();
      const response = await fetchWithRetries(
        reviewPageUrl,
        new Set([404]),
        true,
      );
      const retryExhausted = ARTIST_SKIPPABLE_STATUSES.has(response.status);

      if (retryExhausted) {
        console.error(
          `Skipping artist review page after retries: HTTP ${response.status} ${reviewPageUrl}`,
        );
      } else if (response.status !== 404) {
        const $ = cheerio.load(await response.text());
        $("a[href]").each((_, element) => {
          const reviewUrl = normalizeReviewUrl(
            $(element).attr("href"),
            reviewPageUrl,
          );
          if (reviewUrl) {
            reviewUrls.add(reviewUrl);
          }
        });
      } else if (options.verbose) {
        console.error(`No artist review page found at ${reviewPageUrl}`);
      }

      const inserted = storeArtistReviewPage(
        reviewPageUrl,
        artistUrl,
        reviewUrls,
        retryExhausted ? "artist-reviews-skipped" : "artist-reviews",
      );
      crawledArtists += 1;
      totalArtists = countArtists.get().count;
      console.error(
        `Crawling artist reviews: ${crawledArtists}/${totalArtists} ${reviewPageUrl}, ${inserted} new reviews, ${countReviews.get().count} total reviews`,
      );
    }

    const skippedAtStart = countSkippedArtists.get().count;
    let skippedRetried = 0;
    let skippedRecovered = 0;
    let skippedCursor = "";
    let skippedArtist;

    if (skippedAtStart > 0) {
      console.error(`Retrying ${skippedAtStart} skipped artist review pages`);
    }

    while ((skippedArtist = getNextSkippedArtist.get(skippedCursor))) {
      const artistUrl = skippedArtist.artist_url;
      const reviewPageUrl = skippedArtist.review_page_url;
      const reviewUrls = new Set();

      skippedCursor = reviewPageUrl;
      skippedRetried += 1;

      if (options.verbose) {
        console.error(`Retrying skipped page ${reviewPageUrl}`);
      }

      const response = await fetchWithRetries(
        reviewPageUrl,
        new Set([404]),
        true,
      );
      const retryExhausted = ARTIST_SKIPPABLE_STATUSES.has(response.status);

      if (!retryExhausted && response.status !== 404) {
        const $ = cheerio.load(await response.text());
        $("a[href]").each((_, element) => {
          const reviewUrl = normalizeReviewUrl(
            $(element).attr("href"),
            reviewPageUrl,
          );
          if (reviewUrl) {
            reviewUrls.add(reviewUrl);
          }
        });
      }

      const inserted = storeArtistReviewPage(
        reviewPageUrl,
        artistUrl,
        reviewUrls,
        retryExhausted ? "artist-reviews-skipped" : "artist-reviews",
      );

      if (retryExhausted) {
        console.error(
          `Skipped retry still failing: HTTP ${response.status} ${reviewPageUrl}`,
        );
      } else {
        skippedRecovered += 1;
        console.error(
          `Recovered skipped artist page: ${skippedRetried}/${skippedAtStart} ${reviewPageUrl}, ${inserted} new reviews`,
        );
      }
    }

    if (skippedAtStart > 0) {
      console.error(
        `Skipped-page retries complete: ${skippedRecovered} recovered, ${countSkippedArtists.get().count} still skipped`,
      );
    }

    console.error(
      `Done. Artists: ${countArtists.get().count}. Review URLs: ${countReviews.get().count}. Pages visited: ${countVisitedPages.get().count}.`,
    );
  }

  function updateCutoff() {
    if (options.since) {
      return options.since;
    }

    // Start from the last completed update, or from when the full crawl began.
    const { last_started_at: lastStartedAt } = database
      .prepare(
        "select max(started_at) as last_started_at from update_runs where completed_at is not null",
      )
      .get();
    const { first_found_at: firstFoundAt } = database
      .prepare("select min(found_at) as first_found_at from review_urls")
      .get();
    const reference = lastStartedAt ?? firstFoundAt;
    if (!reference) {
      throw new Error(
        "No existing reviews to update from. Run pnpm pitchfork:crawl first, or pass --since.",
      );
    }

    const referenceDate = new Date(`${reference.replace(" ", "T")}Z`);
    return new Date(
      referenceDate.getTime() - options.marginDays * 24 * 60 * 60 * 1000,
    );
  }

  async function crawlRecentReviews() {
    const cutoff = updateCutoff();
    const startedAt = new Date().toISOString().replace("T", " ").slice(0, 19);
    const runId = database
      .prepare("insert into update_runs (started_at, cutoff) values (?, ?)")
      .run(startedAt, cutoff.toISOString()).lastInsertRowid;
    const updateRun = database.prepare(`
      update update_runs
      set pages = ?, inserted = ?, completed_at = ?
      where id = ?
    `);

    console.error(
      `Updating from review listing until reviews published before ${cutoff.toISOString()}`,
    );

    let pageUrl = new URL("/reviews/albums/", BASE_URL);
    pageUrl.searchParams.set("page", "1");
    const seenPages = new Set();
    let pages = 0;
    let totalInserted = 0;

    while (pageUrl) {
      const currentUrl = pageUrl.href;
      if (seenPages.has(currentUrl)) {
        throw new Error(`Listing pagination loop detected at ${currentUrl}`);
      }
      seenPages.add(currentUrl);
      if (options.verbose) {
        console.error(`Fetching ${currentUrl}`);
      }

      // Pitchfork serves pages past the end of the listing (page 93 as of
      // October 2026) as "Page Not Found" with HTTP 500.
      let response = await fetchWithRetries(currentUrl, new Set([500]));
      let html = await response.text();
      if (response.status === 500) {
        if (pages > 0 && /<title>Page Not Found/i.test(html)) {
          console.error(`Reached end of review listing at ${currentUrl}`);
          break;
        }
        response = await fetchWithRetries(currentUrl);
        html = await response.text();
      }
      const $ = cheerio.load(html);
      const reviewUrls = new Set();

      $("a[href]").each((_, element) => {
        const reviewUrl = normalizeReviewUrl(
          $(element).attr("href"),
          currentUrl,
        );
        if (reviewUrl) {
          reviewUrls.add(reviewUrl);
        }
      });

      const pubDates = [...html.matchAll(/"pubDate":"([^"]+)"/g)]
        .map(([, value]) => Date.parse(value))
        .filter((value) => !Number.isNaN(value));
      if (reviewUrls.size === 0 || pubDates.length === 0) {
        throw new Error(
          `Found no reviews or publish dates on listing page ${currentUrl}; page layout may have changed`,
        );
      }

      const inserted = storeListingPage(reviewUrls);
      pages += 1;
      totalInserted += inserted;
      updateRun.run(pages, totalInserted, null, runId);

      const newest = new Date(Math.max(...pubDates));
      const oldest = new Date(Math.min(...pubDates));
      console.error(
        `Listing page ${pages}: ${oldest.toISOString().slice(0, 10)} to ${newest.toISOString().slice(0, 10)}, ${inserted} new reviews, ${countReviews.get().count} total reviews`,
      );

      if (oldest < cutoff) {
        break;
      }

      const nextUrl = findNextPage($, currentUrl);
      pageUrl = nextUrl ? new URL(nextUrl) : null;
      if (
        pageUrl &&
        (pageUrl.origin !== BASE_URL || pageUrl.pathname !== "/reviews/albums/")
      ) {
        throw new Error(`Refusing unexpected next-page URL: ${nextUrl}`);
      }
    }

    updateRun.run(
      pages,
      totalInserted,
      new Date().toISOString().replace("T", " ").slice(0, 19),
      runId,
    );
    console.error(
      `Done. ${totalInserted} new reviews from ${pages} listing pages. Review URLs: ${countReviews.get().count}.`,
    );
  }

  try {
    if (options.update) {
      await crawlRecentReviews();
    } else {
      await crawlArtists();
    }
  } finally {
    database.close();
  }
}
