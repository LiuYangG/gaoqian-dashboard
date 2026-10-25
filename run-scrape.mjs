import { scrapeAll } from "./scraper.mjs";
let last = "";
// Default: re-fetch the whole current scoreboard so re-judged/duplicated records
// are overwritten instead of accumulating from an old cache.
const force = process.env.FORCE_SCRAPE !== "0";
const snap = await scrapeAll({
  force,
  onProgress: (p) => {
    const line = `[${p.phase}] ${p.message}`;
    if (line !== last) { console.log(line); last = line; }
  },
});
console.log("DONE", JSON.stringify(snap.stats), force ? "(force)" : "(cached)");
