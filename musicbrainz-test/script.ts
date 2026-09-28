// musicbrainz-test.ts
//
// Usage:
//   npx tsx musicbrainz-test.ts input.json > results.json
//
// input.json:
// [
//   { "artist": ["Saint Vengeur"], "album": "GODLESS TONIGHT" },
//   ...
// ]

import fs from "node:fs/promises";

type InputAlbum = {
  artist: string[];
  album: string;
};

const USER_AGENT =
  "Flipper/0.1 (https://flipper.fm)";

const BASE = "https://musicbrainz.org/ws/2";
const REQUEST_INTERVAL_MS = 1100;

let lastRequest = 0;

async function mbFetch(path: string) {
  // Enforce >= 1.1 seconds between requests.
  const elapsed = Date.now() - lastRequest;
  const wait = Math.max(0, REQUEST_INTERVAL_MS - elapsed);

  if (wait) {
    await new Promise(resolve => setTimeout(resolve, wait));
  }

  lastRequest = Date.now();

  const response = await fetch(`${BASE}${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `MusicBrainz ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

function luceneQuote(value: string) {
  // Escape \ and " inside quoted Lucene strings.
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function searchReleaseGroups(input: InputAlbum) {
  // artist is MusicBrainz's combined artist-credit field.
  const artist = input.artist.join(" ");
  const query =
    `releasegroup:${luceneQuote(input.album)} ` +
    `AND artist:${luceneQuote(artist)}`;

  const params = new URLSearchParams({
    query,
    fmt: "json",
    limit: "3",
  });

  return mbFetch(`/release-group?${params}`);
}

async function getReleaseGroup(mbid: string) {
  const params = new URLSearchParams({
    inc: "url-rels+artist-credits",
    fmt: "json",
  });

  return mbFetch(`/release-group/${mbid}?${params}`);
}

async function processAlbum(input: InputAlbum) {
  const search = await searchReleaseGroups(input);

  const candidates = search["release-groups"] ?? [];

  const candidateResults = candidates.map((rg: any) => ({
    mbid: rg.id,
    score: Number(rg.score),
    title: rg.title,
    firstReleaseDate: rg["first-release-date"],
    primaryType: rg["primary-type"],
    artists: (rg["artist-credit"] ?? []).map(
      (x: any) => x.artist?.name ?? x.name
    ),
  }));

  if (!candidates.length) {
    return {
      input,
      candidates: [],
      bestMatch: null,
    };
  }

  // Fetch relationships only for the best candidate.
  const best = await getReleaseGroup(candidates[0].id);

  const urls = (best.relations ?? [])
    .filter((r: any) => r.url?.resource)
    .map((r: any) => ({
      type: r.type,
      url: r.url.resource,
    }));

  return {
    input,
    candidates: candidateResults,
    bestMatch: {
      mbid: best.id,
      title: best.title,
      urls,
    },
  };
}

async function main() {
  const filename = process.argv[2];

  if (!filename) {
    throw new Error(
      "Usage: npx tsx musicbrainz-test.ts input.json"
    );
  }

  const input: InputAlbum[] = JSON.parse(
    await fs.readFile(filename, "utf8")
  );

  const results = [];

  for (const album of input) {
    console.error(
      `Searching: ${album.artist.join(", ")} — ${album.album}`
    );

    try {
      results.push(await processAlbum(album));
    } catch (error) {
      results.push({
        input: album,
        error:
          error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

