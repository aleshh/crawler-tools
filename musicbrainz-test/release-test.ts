import fs from "node:fs/promises";

type InputAlbum = {
  artist: string[];
  album: string;
};

const BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "Flipper/0.1 (https://flipper.fm)";
const INTERVAL = 1100;

let lastRequest = 0;

async function mbFetch(path: string, attempt = 0): Promise<any> {
  const wait = Math.max(0, INTERVAL - (Date.now() - lastRequest));
  if (wait) await new Promise(r => setTimeout(r, wait));

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
    await new Promise(r => setTimeout(r, delay));
    return mbFetch(path, attempt + 1);
  }

  if (!response.ok)
    throw new Error(`MusicBrainz ${response.status}: ${await response.text()}`);

  return response.json();
}

function quote(s: string) {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function main() {
  const filename = process.argv[2];
  if (!filename) throw new Error("Provide input JSON");

  const albums: InputAlbum[] =
    JSON.parse(await fs.readFile(filename, "utf8"));

  // Pick Caiola from the existing input
  const input = albums.find(
    a => a.artist.includes("Caiola") &&
         a.album === "This Could Be Everything"
  );

  if (!input) throw new Error("Caiola album not found");

  // Find release group
  const query =
    `releasegroup:${quote(input.album)} AND artist:${quote(input.artist.join(" "))}`;

  const search = await mbFetch(
    `/release-group?${new URLSearchParams({
      query,
      fmt: "json",
      limit: "3",
    })}`
  );

  const rg = search["release-groups"]?.[0];
  if (!rg) throw new Error("No release group found");

  console.error(`Release group: ${rg.title} (${rg.id})`);

  // Browse releases belonging to release group
  const releases = await mbFetch(
    `/release?${new URLSearchParams({
      "release-group": rg.id,
      inc: "artist-credits+url-rels",
      fmt: "json",
      limit: "100",
    })}`
  );

  const result = {
    input,
    releaseGroup: {
      mbid: rg.id,
      title: rg.title,
      score: rg.score,
    },

    releases: (releases.releases ?? []).map((r: any) => ({
      mbid: r.id,
      title: r.title,
      date: r.date,
      country: r.country,
      status: r.status,
      barcode: r.barcode,

      urls: (r.relations ?? [])
        .filter((rel: any) => rel.url?.resource)
        .map((rel: any) => ({
          type: rel.type,
          url: rel.url.resource,
        })),
    })),
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

