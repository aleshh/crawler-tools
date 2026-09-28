// release-test.ts
//
// npx tsx release-test.ts input.json > results.json

import fs from "node:fs/promises";

type InputAlbum = {
  artist: string[];
  album: string;
};

const BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "Flipper/0.1 (https://flipper.fm)";
const INTERVAL = 1100;

let lastRequest = 0;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mbFetch(path: string, attempt = 0): Promise<any> {
  const wait = Math.max(0, INTERVAL - (Date.now() - lastRequest));
  if (wait) await sleep(wait);

  lastRequest = Date.now();

  const response = await fetch(`${BASE}${path}`, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  if (response.status === 503 && attempt < 5) {
    const delay = 2000 * 2 ** attempt;
    console.error(`503 — retrying in ${delay / 1000}s`);
    await sleep(delay);
    return mbFetch(path, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(
      `MusicBrainz ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

function quote(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function processAlbum(input: InputAlbum) {
  console.error(
    `\nSearching: ${input.artist.join(", ")} — ${input.album}`
  );

  // 1. Find release group
  const query =
    `releasegroup:${quote(input.album)} ` +
    `AND artist:${quote(input.artist.join(" "))}`;

  const search = await mbFetch(
    `/release-group?${new URLSearchParams({
      query,
      fmt: "json",
      limit: "3",
    })}`
  );

  const candidates = search["release-groups"] ?? [];

  if (!candidates.length) {
    console.error("  No release group found");

    return {
      input,
      match: null,
    };
  }

  const rg = candidates[0];

  console.error(
    `  Match: ${rg.title} (${rg.id}), score ${rg.score}`
  );

  // 2. Get releases + URL relationships
  const releasesResponse = await mbFetch(
    `/release?${new URLSearchParams({
      "release-group": rg.id,
      inc: "artist-credits+url-rels",
      fmt: "json",
      limit: "100",
    })}`
  );

  const releases = releasesResponse.releases ?? [];

  // 3. Preserve release-specific data
  const releaseResults = releases.map((release: any) => ({
    mbid: release.id,
    title: release.title,
    date: release.date,
    country: release.country,
    status: release.status,
    barcode: release.barcode,

    urls: (release.relations ?? [])
      .filter((rel: any) => rel.url?.resource)
      .map((rel: any) => ({
        type: rel.type,
        url: rel.url.resource,
      })),
  }));

  // 4. Also make a convenient deduplicated list across editions
  const urlMap = new Map<
    string,
    {
      type: string;
      url: string;
    }
  >();

  for (const release of releaseResults) {
    for (const relation of release.urls) {
      if (!urlMap.has(relation.url)) {
        urlMap.set(relation.url, relation);
      }
    }
  }

  const urls = [...urlMap.values()];

  console.error(
    `  ${releases.length} release(s), ${urls.length} unique URL(s)`
  );

  return {
    input,

    match: {
      releaseGroupMbid: rg.id,
      title: rg.title,
      score: Number(rg.score),
      firstReleaseDate: rg["first-release-date"],
      primaryType: rg["primary-type"],
    },

    urls,

    releases: releaseResults,
  };
}

async function main() {
  const filename = process.argv[2];

  if (!filename) {
    throw new Error(
      "Usage: npx tsx release-test.ts input.json"
    );
  }

  const inputs: InputAlbum[] = JSON.parse(
    await fs.readFile(filename, "utf8")
  );

  const results = [];

  for (const input of inputs) {
    try {
      results.push(await processAlbum(input));
    } catch (error) {
      console.error(`  ERROR: ${error}`);

      results.push({
        input,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      });
    }
  }

  console.log(JSON.stringify(results, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

