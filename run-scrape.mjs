import { scrapeAll } from "./scraper.mjs";
let last = "";
const snap = await scrapeAll({
  onProgress: (p) => {
    const line = `[${p.phase}] ${p.message}`;
    if (line !== last) { console.log(line); last = line; }
  },
});
console.log("DONE", JSON.stringify(snap.stats));
