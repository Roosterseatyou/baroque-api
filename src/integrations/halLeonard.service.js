import axios from "axios";
import { load } from "cheerio";

const USER_AGENT = "BaroqueBot/1.0 (+mailto:dev@example.com)";

function textOrNull(s) {
  if (!s) return null;
  const t = s.trim();
  return t.length ? t : null;
}

export async function fetchProductByUrl(url) {
  try {
    const res = await axios.get(url, {
      headers: { "User-Agent": USER_AGENT },
      timeout: 10000,
    });
    const html = res.data;
    const $ = load(html);

    // try JSON-LD
    let jsonLd = null;
    const ld = $('script[type="application/ld+json"]').first().text();
    if (ld) {
      try {
        jsonLd = JSON.parse(ld);
      } catch (e) {
        jsonLd = null;
      }
    }

    const title = textOrNull(
      (jsonLd && (jsonLd.name || jsonLd.headline)) ||
        $('meta[property="og:title"]').attr("content") ||
        $("h1").first().text(),
    );
    const thumbnail = textOrNull(
      (jsonLd && jsonLd.image) ||
        $('meta[property="og:image"]').attr("content") ||
        $(".product-image").first().attr("src"),
    );

    // composer: look for contributor link or label
    let composer = null;
    // common pattern: 'By: Composer Name' or link to /artist/
    const contributorEls = $("a").filter((i, el) => {
      const href = $(el).attr("href") || "";
      return href.includes("/artist/") || href.includes("/composer/");
    });
    if (contributorEls && contributorEls.length)
      composer = textOrNull($(contributorEls[0]).text());
    // fallback search for labels
    if (!composer) {
      const compLabel = $(':contains("Composer")')
        .filter(function () {
          return (
            $(this).text().trim().startsWith("Composer") ||
            $(this).text().trim().startsWith("Composed by")
          );
        })
        .first();
      if (compLabel && compLabel.length) {
        // take next sibling or parent text
        composer = textOrNull(
          compLabel.next().text() || compLabel.parent().text(),
        );
      }
    }

    // publisher / sku
    let publisher = textOrNull(
      (jsonLd &&
        jsonLd.publisher &&
        (jsonLd.publisher.name || jsonLd.publisher)) ||
        $('meta[name="publisher"]').attr("content"),
    );
    if (!publisher) {
      // try page labels
      const pubEl = $(':contains("Publisher")')
        .filter(function () {
          return $(this).text().trim().startsWith("Publisher");
        })
        .first();
      if (pubEl && pubEl.length)
        publisher = textOrNull(pubEl.next().text() || pubEl.parent().text());
    }

    // SKU or product id from URL
    let sku = null;
    const skuMatch = url.match(/\/product\/(\d+)\//);
    if (skuMatch) sku = skuMatch[1];
    // fallback: look for product code on page
    if (!sku) {
      const codeEl = $(':contains("Product #")')
        .filter(function () {
          return $(this).text().includes("Product");
        })
        .first();
      if (codeEl && codeEl.length)
        sku = textOrNull(codeEl.text().replace(/[^0-9]/g, ""));
    }

    // instrumentation or description
    const instrumentation = textOrNull(
      $(".product-info .product-subtitle").text() ||
        $(".cover-caption-sub").first().text() ||
        jsonLd?.description,
    );

    // try to extract ISMN if present on page
    let ismn = null;
    const pageText = $("body").text();
    const ismnMatch = pageText.match(/ISMN[:\s]*([0-9\-]+)/i);
    if (ismnMatch) ismn = ismnMatch[1];

    const metadata = {
      title,
      composer,
      arranger: null,
      publisher,
      catalogNumber: sku,
      ismn,
      instrumentation,
      thumbnailUrl: thumbnail,
      source: { site: "hal-leonard", url },
    };

    // minimal sanity: require title
    if (!metadata.title) return null;
    return metadata;
  } catch (err) {
    console.error("fetchProductByUrl error", err && err.message);
    return null;
  }
}
