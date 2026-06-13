#!/usr/bin/env node
import Database from "better-sqlite3";
import { createWriteStream, mkdirSync } from "node:fs";
import { once } from "node:events";

const OUTPUT_DIRECTORY = "output";
const DATABASE_PATH = `${OUTPUT_DIRECTORY}/pitchfork.sqlite`;
const OUTPUT_PATH = `${OUTPUT_DIRECTORY}/pitchfork-review-urls.txt`;

mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
let database;
try {
  database = new Database(DATABASE_PATH, { readonly: true, fileMustExist: true });
} catch {
  console.error(`Database not found at ${DATABASE_PATH}. Run pnpm pitchfork:crawl first.`);
  process.exit(1);
}
const output = createWriteStream(OUTPUT_PATH, { encoding: "utf8" });
let exported = 0;

try {
  const rows = database
    .prepare("select url from review_urls order by url")
    .iterate();

  for (const { url } of rows) {
    if (!output.write(`${url}\n`)) {
      await once(output, "drain");
    }
    exported += 1;
  }
} finally {
  database.close();
  output.end();
}

await once(output, "finish");
console.error(`Exported ${exported} review URLs to ${OUTPUT_PATH}`);
