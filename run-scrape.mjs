import { scrapeAll } from "./scraper.mjs";
let last = "";
// Incremental by default: reuse cached record details and only fetch new ones.
// Set FORCE_SCRAPE=1 for a one-off full refresh.
const force = process.env.FORCE_SCRAPE === "1";
const snap = await scrapeAll({
  force,
  onProgress: (p) => {
    const line = `[${p.phase}] ${p.message}`;
    if (line !== last) { console.log(line); last = line; }
  },
});
console.log("DONE", JSON.stringify(snap.stats), force ? "(force)" : "(incremental)");
