import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  dateOnly, windowFor, inWindow, httpUrl, parseFeed, structuredEvents, parseOfficial,
  textEvents, namesMatch, reconcileOfficial, deduplicate, mapLimit, fetchText, renderMarkdown,
} from "./tracker.mjs";

const ROOT = new URL("../", import.meta.url);

export async function collect(config, { asOf = new Date().toISOString().slice(0, 10), generatedAt = new Date().toISOString(), getText = fetchText } = {}) {
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
  const firstYear = Number(window.start.slice(0, 4));
  const lastYear = Number(window.end.slice(0, 4));
  if (!config.discovery.topics?.length || !config.discovery.requiredTopics?.length
    || !config.discovery.requiredTopics.every((topic) => config.discovery.topics.includes(topic))) {
    throw new Error("Discovery must configure topics and a nonempty requiredTopics subset");
  }
  const files = [];
  for (let year = firstYear; year <= lastYear; year++) {
    for (const topic of config.discovery.topics) {
      if (!/^[a-z-]+$/.test(topic)) throw new Error(`Invalid discovery topic: ${topic}`);
      files.push({ path: `conferences/${year}/${topic}.json`, year, topic });
    }
  }
  const batches = await mapLimit(files, 4, async (file) => {
    const url = new URL(file.path, config.discovery.rawBaseUrl).href;
    const source = { name: `${config.discovery.name} ${file.year}/${file.topic}`, url, topic: file.topic };
    try {
      const events = parseFeed(JSON.parse(await getText(url)), source);
      return { events, check: { name: source.name, url, status: "ok", detail: `${events.filter((event) => inWindow(event, window)).length} matching US entries before deduplication` } };
    } catch (error) {
      const optional = file.year > firstYear || !config.discovery.requiredTopics.includes(file.topic);
      if (error.status !== 404 || !optional) throw error;
      return { events: [], check: { name: source.name, url, status: "limited", detail: "Topic/year file not published (HTTP 404); this part of discovery is unavailable" } };
    }
  });
  const feedEvents = batches.flatMap((batch) => batch.events).filter((event) => inWindow(event, window));
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
      return { event: reconciled, check: { name: event.name, url: event.url, status: structured.warnings.length ? "warning" : reconciled?.evidence === "Feed only" ? "limited" : "ok", detail: [detail, ...structured.warnings].join("; ") } };
    } catch (error) {
      return { event, check: { name: event.name, url: event.url, status: "warning", detail: `Invalid official event data; dates remain feed-only: ${error.message}` } };
    }
  });
  checks.push(...verifiedFeed.map((result) => result.check));
  const events = deduplicate([
    ...verifiedFeed.map((result) => result.event).filter(Boolean),
    ...watchResults.flatMap((result) => result.events),
  ]).filter((event) => inWindow(event, window));
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
  const snapshot = await collect(config, options);
  const markdown = renderMarkdown(snapshot);
  const destination = new URL("CONFERENCES.md", root);
  const temporary = new URL(`CONFERENCES.md.${randomUUID()}.tmp`, root);
  try {
    await writeFile(temporary, markdown, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  for (const check of snapshot.checks.filter((check) => ["warning", "unavailable"].includes(check.status))) {
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
