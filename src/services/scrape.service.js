import * as halService from "../integrations/halLeonard.service.js";
import axios from "axios";
import { load } from "cheerio";

const USER_AGENT = "BaroqueBot/1.0 (+mailto:dev@example.com)";
const cache = new Map(); // simple in-memory cache: url -> { data, fetchedAt }
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours

export async function scrapeHalLeonard(url) {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await halService.fetchProductByUrl(url);
  if (data) cache.set(url, { data, fetchedAt: Date.now() });
  return data;
}

// search by title/composer on Hal Leonard and return top N results (normalized metadata)
export async function scrapeByQuery({ title, composer, maxResults = 3 }) {
  // build keywords: prioritize title, append composer
  const keywords = encodeURIComponent(
    ((title || "") + " " + (composer || "")).trim(),
  );
  const searchUrl = `https://www.halleonard.com/search/search.action?keywords=${keywords}&dt=item`;

  let $;
  try {
    // fetch search page
    const res = await axios.get(searchUrl, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 10000,
    });
    $ = load(res.data);
  } catch (error) {
    if (axios.isAxiosError && axios.isAxiosError(error)) {
      const status = error.response && error.response.status;
      const statusText = error.response && error.response.statusText;
      let message = "Failed to fetch Hal Leonard search results";
      if (status) {
        message += ` (status ${status}${statusText ? " " + statusText : ""})`;
      }
      const queryStr = ((title || "") + " " + (composer || "")).trim();
      if (queryStr) {
        message += ` for query "${queryStr}".`;
      } else {
        message += ".";
      }
      throw new Error(message);
    }
    const baseMessage =
      "Unexpected error while fetching Hal Leonard search results";
    const detail = error && error.message ? `: ${error.message}` : "";
    throw new Error(baseMessage + detail);
  }
  // product links on search results use /product/<id>/<slug>
  const links = new Set();
  $('a[href^="/product/"]').each((i, el) => {
    if (links.size >= maxResults) return;
    const href = $(el).attr("href");
    if (href) links.add(new URL(href, "https://www.halleonard.com").toString());
  });

  const results = [];
  for (const url of Array.from(links).slice(0, maxResults)) {
    // polite small delay between product fetches
    await new Promise((r) => setTimeout(r, 300));
    const md = await scrapeHalLeonard(url);
    if (md) results.push(md);
  }
  return results;
}
