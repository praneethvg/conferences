import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dateOnly, windowFor, inWindow, httpUrl, parseFeed, parseDevelopersFeed, structuredEvents, parseOfficial,
  textEvents, namesMatch, normalizedName, reconcileOfficial, deduplicate, mapLimit, fetchText, renderMarkdown, TOPICS,
} from "./tracker.mjs";
import { ticketDetails } from "./tickets.mjs";

const ROOT = new URL("../", import.meta.url);

async function collectDiscovery(source, window, getText) {
  if (source.type === "developers-events") {
    const records = JSON.parse(await getText(source.url));
    const events = parseDevelopersFeed(records, source).filter((event) => inWindow(event, window));
    return [{ events, check: {
      name: source.name, url: source.url, status: "ok",
      detail: `${records.length} records read; ${events.length} matching US entries before deduplication`,
    } }];
  }
  if (source.type !== "confs-tech") throw new Error(`Unsupported discovery source type: ${source.type}`);
  const firstYear = Number(window.start.slice(0, 4));
  const lastYear = Number(window.end.slice(0, 4));
  if (!source.topics?.length || !source.requiredTopics?.length
    || !source.requiredTopics.every((topic) => source.topics.includes(topic))) {
    throw new Error("Discovery must configure topics and a nonempty requiredTopics subset");
  }
  const files = [];
  for (let year = firstYear; year <= lastYear; year++) {
    for (const topic of source.topics) {
      if (!/^[a-z-]+$/.test(topic)) throw new Error(`Invalid discovery topic: ${topic}`);
      files.push({ path: `conferences/${year}/${topic}.json`, year, topic });
    }
  }
  return mapLimit(files, 4, async (file) => {
    const url = new URL(file.path, source.rawBaseUrl).href;
    const fileSource = { name: `${source.name} ${file.year}/${file.topic}`, url, topic: file.topic };
    try {
      const events = parseFeed(JSON.parse(await getText(url)), fileSource).filter((event) => inWindow(event, window));
      return { events, check: { name: fileSource.name, url, status: "ok", detail: `${events.length} matching US entries before deduplication` } };
    } catch (error) {
      const optional = file.year > firstYear || !source.requiredTopics.includes(file.topic);
      if (error.status !== 404 || !optional) throw error;
      return { events: [], check: { name: fileSource.name, url, status: "limited", detail: "Topic/year file not published (HTTP 404); this part of discovery is unavailable" } };
    }
  });
}

export async function collect(config, { asOf = new Date().toISOString().slice(0, 10), generatedAt = new Date().toISOString(), getText = fetchText, previousEvents = [] } = {}) {
  const window = windowFor(asOf);
  const checks = [];
  const cache = new Map();
  function page(url) {
    const key = httpUrl(url);
    if (!cache.has(key)) {
      cache.set(key, getText(key).then((html) => ({ html, error: null }), (error) => ({ html: null, error })));
    }
    return cache.get(key);
  }
  if (!Array.isArray(config.discovery) || !config.discovery.length) throw new Error("Configure at least one discovery source");
  const batches = (await mapLimit(config.discovery, 1, (source) => collectDiscovery(source, window, getText))).flat();
  const feedEvents = batches.flatMap((batch) => batch.events);
  checks.push(...batches.map((batch) => batch.check));
  const watchResults = await mapLimit(config.official, 4, async (source) => {
    const result = await page(source.url);
    const events = [];
    const warnings = [];
    if (result.error) {
      return { events, source: { ...source, detail: result.error.message }, check: { name: source.name, url: source.url, status: "unavailable", detail: result.error.message } };
    }
    const structured = structuredEvents(result.html);
    warnings.push(...structured.warnings);
    for (const record of structured.events) {
      if (typeof record.name !== "string" || !namesMatch(record.name, source.names)) continue;
      try {
        const event = parseOfficial(record, source.url, source.topics);
        if (event && inWindow(event, window)) events.push(event);
      } catch (error) {
        warnings.push(error.message);
      }
    }
    try {
      events.push(...textEvents(result.html, source).filter((event) => inWindow(event, window)));
    } catch (error) {
      warnings.push(error.message);
    }
    const uniqueEvents = deduplicate(events);
    const detail = [
      uniqueEvents.length ? `${uniqueEvents.length} upcoming US event(s) with official evidence` : "No supported upcoming US date evidence; not confirmation that dates are unannounced",
      ...warnings,
    ].join("; ");
    return { events: uniqueEvents, source: { ...source, detail }, check: { name: source.name, url: source.url, status: warnings.length ? "warning" : uniqueEvents.length ? "ok" : "limited", detail } };
  });
  checks.push(...watchResults.map((result) => result.check));
  const verifiedFeed = await mapLimit(deduplicate(feedEvents), 4, async (event) => {
    const result = await page(event.url);
    if (result.error) {
      return { event, check: { name: event.name, url: event.url, status: "unavailable", detail: result.error.message } };
    }
    const structured = structuredEvents(result.html);
    try {
      const reconciled = reconcileOfficial(event, structured.events, event.url);
      const detail = reconciled === null ? "Excluded: official data indicates cancellation, postponement, online-only, or a non-US venue"
        : reconciled.evidence === "Feed only" ? "No unambiguous matching official Event data; dates remain feed-only"
          : "Official event dates and US venue checked";
      return { event: reconciled, excluded: reconciled === null ? event : null, check: { name: event.name, url: event.url, status: structured.warnings.length ? "warning" : reconciled?.evidence === "Feed only" ? "limited" : "ok", detail: [detail, ...structured.warnings].join("; ") } };
    } catch (error) {
      return { event, check: { name: event.name, url: event.url, status: "warning", detail: `Invalid official event data; dates remain feed-only: ${error.message}` } };
    }
  });
  checks.push(...verifiedFeed.map((result) => result.check));
  const fresh = deduplicate([
    ...verifiedFeed.map((result) => result.event).filter(Boolean),
    ...watchResults.flatMap((result) => result.events),
  ]).map((event) => ({
    ...event,
    stale: false,
    lastVerifiedAt: event.evidence === "Feed only" ? null : generatedAt,
  }));
  const edition = (event) => `${normalizedName(event.name)}|${event.start.slice(0, 4)}`;
  const seen = new Set([...fresh, ...verifiedFeed.map((result) => result.excluded).filter(Boolean)].map(edition));
  const unavailable = new Set(checks.filter((check) => check.status === "unavailable").map((check) => httpUrl(check.url)));
  const retained = previousEvents.filter((event) => event.evidence !== "Feed only" && event.lastVerifiedAt
    && !seen.has(edition(event)) && inWindow(event, window)
    && event.sources.some((url) => unavailable.has(httpUrl(url))))
    .map((event) => ({ ...event, stale: true }));
  for (const event of retained) {
    checks.push({ name: event.name, url: event.url, status: "stale", detail: `Retained from unavailable official source; last verified ${event.lastVerifiedAt}` });
  }
  const datedEvents = deduplicate([...fresh, ...retained]).filter((event) => inWindow(event, window));
  const ticketResults = await mapLimit(datedEvents, 4, async (event) => {
    if (event.stale) return { event };
    const result = await page(event.url);
    if (result.error) return { event };
    try {
      let tickets = ticketDetails(event, result.html, event.url, window.start);
      const registrationPage = tickets.registrationUrl && new URL(tickets.registrationUrl).origin === new URL(event.url).origin
        && httpUrl(tickets.registrationUrl) !== httpUrl(event.url) ? tickets.registrationUrl : null;
      const pricePageUrl = tickets.pricingUrl ?? registrationPage;
      if (!tickets.price && pricePageUrl) {
        const pricing = await page(pricePageUrl);
        if (pricing.error) {
          return { event: { ...event, ...tickets, ticketCheckedAt: generatedAt }, check: {
            name: `${event.name} pricing`, url: pricePageUrl, status: "unavailable", detail: pricing.error.message,
          } };
        }
        const extra = ticketDetails(event, pricing.html, pricePageUrl, window.start);
        tickets = {
          ...tickets,
          price: extra.price,
          registrationUrl: tickets.registrationUrl ?? extra.registrationUrl,
          registrationLabel: tickets.registrationUrl ? tickets.registrationLabel : extra.registrationLabel,
        };
      }
      return { event: { ...event, ...tickets, ticketCheckedAt: generatedAt } };
    } catch (error) {
      return { event, check: { name: `${event.name} tickets`, url: event.url, status: "warning", detail: `Ticket details not verified: ${error.message}` } };
    }
  });
  const events = ticketResults.map((result) => result.event);
  checks.push(...ticketResults.map((result) => result.check).filter(Boolean));
  if (!events.length) throw new Error("No matching events found; refusing to replace the previous snapshot with an empty list");
  return {
    generatedAt,
    window,
    events,
    watchlist: watchResults.map((result) => result.source),
    checks,
  };
}

export async function refresh({ root = ROOT, ...options } = {}) {
  const config = JSON.parse(await readFile(new URL("sources.json", root), "utf8"));
  let previousEvents = [];
  let cacheText;
  try {
    cacheText = await readFile(new URL("conference-cache.json", root), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (cacheText !== undefined) {
    const cache = JSON.parse(cacheText);
    if (cache.version !== 1 || !Array.isArray(cache.events)) throw new Error("Invalid conference cache schema");
    for (const event of cache.events) {
      if (!event || typeof event.name !== "string" || typeof event.city !== "string" || event.country !== "US"
        || !["Feed only", "Official structured data", "Official page evidence"].includes(event.evidence)
        || !Array.isArray(event.topics) || !event.topics.length || !event.topics.every((topic) => TOPICS.includes(topic))
        || !Array.isArray(event.sources) || !event.sources.length
        || (event.lastVerifiedAt !== null && !Number.isFinite(Date.parse(event.lastVerifiedAt)))) {
        throw new Error("Invalid conference cache event");
      }
      dateOnly(event.start);
      dateOnly(event.end);
      if (event.end < event.start) throw new Error("Invalid conference cache date range");
      httpUrl(event.url);
      event.sources.forEach(httpUrl);
      if (event.price) {
        if (typeof event.price.label !== "string") throw new Error("Invalid cached ticket price");
        httpUrl(event.price.url);
      }
      if (event.registrationUrl) httpUrl(event.registrationUrl);
      if (event.pricingUrl) httpUrl(event.pricingUrl);
    }
    previousEvents = cache.events;
  }
  const snapshot = await collect(config, { ...options, previousEvents });
  const markdown = renderMarkdown(snapshot);
  const destination = new URL("CONFERENCES.md", root);
  const cacheDestination = new URL("conference-cache.json", root);
  const temporary = new URL(`CONFERENCES.md.${randomUUID()}.tmp`, root);
  const cacheTemporary = new URL(`conference-cache.json.${randomUUID()}.tmp`, root);
  try {
    await writeFile(temporary, markdown, { flag: "wx" });
    await writeFile(cacheTemporary, `${JSON.stringify({ version: 1, generatedAt: snapshot.generatedAt, events: snapshot.events }, null, 2)}\n`, { flag: "wx" });
    await rename(cacheTemporary, cacheDestination);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
    await rm(cacheTemporary, { force: true });
  }
  for (const check of snapshot.checks.filter((check) => ["warning", "unavailable", "stale"].includes(check.status))) {
    console.warn(`${check.status}: ${check.name}: ${check.detail}`);
  }
  console.log(`Updated ${fileURLToPath(destination)}: ${snapshot.events.length} events, ${snapshot.window.start} to ${snapshot.window.end} (exclusive)`);
  return snapshot;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--as-of")) throw new Error("Usage: npm run refresh -- [--as-of YYYY-MM-DD]");
    if (args.length && !/^\d{4}-\d{2}-\d{2}$/.test(args[1])) throw new Error("--as-of must be YYYY-MM-DD");
    const asOf = args.length ? dateOnly(args[1]) : undefined;
    await refresh({ asOf });
  } catch (error) {
    console.error(`Refresh failed; previous CONFERENCES.md preserved: ${error.stack ?? error.message}`);
    process.exitCode = 1;
  }
}
