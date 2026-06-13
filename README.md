# Crawler tools

## Pitchfork review URL crawler

Requires Node.js 22+ and pnpm. Install dependencies:

```sh
pnpm install
```

Crawl Pitchfork artist search results for `a` through `z` and `0` through `9`,
then crawl each discovered artist's review page:

```sh
pnpm pitchfork:crawl
```

Use a custom request delay or verbose request logging:

```sh
pnpm pitchfork:crawl --delay-ms 2000 --verbose
```

Artists, review URLs, visited pages, and resume state are stored in
`output/pitchfork.sqlite`. The crawler can be interrupted and rerun without
duplicating records or revisiting completed pages.

If a paginated search response unexpectedly contains no artist URLs, the
crawler stops without saving that page so it can be retried safely.

If an individual artist review page still returns `500`, `502`, `503`, or
`504` after all retries, it is recorded as skipped and the crawl continues.
After all other artists are processed, skipped pages are retried once more.
Pages that recover are marked complete; persistent failures remain skipped for
another retry on the next run.

HTTP `429` rate limits honor the server's `Retry-After` header when available,
otherwise using a longer 30-second to 5-minute backoff. Persistently
rate-limited artist pages use the same skipped-page retry flow.

An existing database from the previous year-search crawler is migrated in
place, preserving its collected review URLs.

Export the stored review URLs as a sorted newline-separated text file:

```sh
pnpm pitchfork:export
```

The export is written to `output/pitchfork-review-urls.txt`.
