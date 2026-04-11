import * as scrapeService from "../services/scrape.service.js";

export async function scrapeUrl(req, res) {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url required" });
    // basic host allowlist
    const allowedHosts = ["www.halleonard.com", "halleonard.com"];
    let host;
    try {
      host = new URL(url).host;
    } catch (e) {
      return res.status(400).json({ error: "invalid url" });
    }
    if (!allowedHosts.includes(host)) {
      return res.status(403).json({ error: "host not supported" });
    }

    const result = await scrapeService.scrapeHalLeonard(url);
    if (!result) return res.status(404).json({ error: "no metadata found" });
    res.status(200).json({ metadata: result });
  } catch (error) {
    console.error("scrapeUrl error", error);
    res.status(500).json({ error: error.message });
  }
}

export async function scrapeByQuery(req, res) {
  try {
    const { title, composer, maxResults } = req.body;
    if (!title && !composer)
      return res.status(400).json({ error: "title or composer required" });
    const results = await scrapeService.scrapeByQuery({
      title,
      composer,
      maxResults: maxResults || 3,
    });
    res.status(200).json({ results });
  } catch (error) {
    console.error("scrapeByQuery error", error);
    res.status(500).json({ error: error.message });
  }
}
