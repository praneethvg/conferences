import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TOPICS, dateOnly, windowFor, isUS, topicsFor, httpUrl, inWindow, normalizedName,
  namesMatch, parseFeed, structuredEvents, parseOfficial, textEvents,
  reconcileOfficial, deduplicate, mapLimit, fetchText, renderMarkdown,
} from "./tracker.mjs";
import { collect, refresh } from "./refresh.mjs";

const source = { name: "confs.tech data", url: "https://feeds.example/data.json", topic: "data" };
const feedRecord = {
  name: "AI Summit 2026",
  startDate: "2026-11-03",
  endDate: "2026-11-05",
  city: "San Jose, CA",
  country: "U.S.A.",
  url: "https://events.example/ai",
};
const officialRecord = {
  "@type": "Event",
  name: "AI Summit 2026",
  startDate: "2026-11-03",
  endDate: "2026-11-05",
  location: {
    "@type": "Place",
    address: { addressCountry: "US", addressLocality: "San Jose", addressRegion: "CA" },
  },
};
const event = parseFeed([feedRecord], source)[0];
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;

test("rolling window is a calendar year, including month/year boundaries", () => {
  assert.deepEqual(windowFor("2026-10-17"), { start: "2026-10-17", end: "2027-10-17" });
  assert.deepEqual(windowFor("2026-12-31"), { start: "2026-12-31", end: "2027-12-31" });
  assert.deepEqual(windowFor("2028-02-29"), { start: "2028-02-29", end: "2029-02-28" });
});

test("date parsing rejects invalid calendar dates and preserves event-local date", () => {
  for (const value of ["2027-02-29", "2026-02-30", "2026-13-01", "yesterday", null, 0, "2026-10-17Tgarbage"]) {
    assert.throws(() => dateOnly(value));
  }
  assert.equal(dateOnly("2028-02-29"), "2028-02-29");
  assert.equal(dateOnly("2026-11-03T23:30:00-08:00"), "2026-11-03");
});

test("range includes ongoing and last-day events but excludes upper-bound starts", () => {
  const window = windowFor("2026-10-17");
  assert.equal(inWindow({ start: "2026-10-16", end: "2026-10-17" }, window), true);
  assert.equal(inWindow({ start: "2027-10-16", end: "2027-10-19" }, window), true);
  assert.equal(inWindow({ start: "2027-10-17", end: "2027-10-17" }, window), false);
  assert.equal(inWindow({ start: "2026-10-15", end: "2026-10-16" }, window), false);
});

test("US aliases are explicit and do not match other countries", () => {
  for (const country of ["US", "USA", "U.S.A.", "United States", "United States of America", { name: "US" }]) assert.equal(isUS(country), true);
  for (const country of ["Australia", "Canada", "Russia", undefined, {}, "US Virgin Islands"]) assert.equal(isUS(country), false);
});

test("topics cover AI and infrastructure without imposing quotas", () => {
  assert.deepEqual(topicsFor("NVIDIA GTC"), ["AI", "AI infrastructure"]);
  assert.deepEqual(topicsFor("Cloud Native AI & Inference Day"), ["AI", "AI infrastructure", "Cloud / Kubernetes"]);
  assert.deepEqual(topicsFor("DevOpsDays Chicago"), ["DevOps / SRE"]);
  assert.deepEqual(topicsFor("Data Centre North America"), ["AI infrastructure", "Data infrastructure"]);
  assert.deepEqual(topicsFor("React Summit", "general"), []);
  assert.deepEqual(topicsFor("Unknown Conference", "sre"), ["DevOps / SRE"]);
  assert.deepEqual(topicsFor("Cloud Summit", undefined, ["AI"]), ["AI", "Cloud / Kubernetes"]);
});

test("feed filters non-US, virtual-only, and cancelled/postponed entries but retains hybrids", () => {
  const records = [
    feedRecord,
    { ...feedRecord, country: "Canada" },
    { ...feedRecord, city: undefined, country: undefined, online: true },
    { ...feedRecord, status: "cancelled" },
    { ...feedRecord, status: "postponed" },
    { ...feedRecord, online: true, name: "Hybrid AI Summit" },
  ];
  const parsed = parseFeed(records, source);
  assert.equal(parsed.length, 2);
  assert.ok(parsed.every((entry) => entry.evidence === "Feed only" && entry.country === "US"));
});

test("feed errors fail explicitly instead of yielding an empty success", () => {
  for (const records of [{}, [null], [{ title: "changed schema" }], [{ ...feedRecord, startDate: "2026-02-30" }], [{ ...feedRecord, endDate: "2026-01-01" }], [{ ...feedRecord, url: "javascript:alert(1)" }]]) {
    assert.throws(() => parseFeed(records, source));
  }
});

test("event URLs reject unsupported schemes and embedded credentials", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:password@example.com/"]) assert.throws(() => httpUrl(url));
  assert.equal(httpUrl("https://example.com/event#schedule"), "https://example.com/event");
});

test("structured parser handles arrays, graphs, single quotes, malformed blocks, and type URLs", () => {
  const html = ld({ "@graph": [{ "@type": "WebSite" }, officialRecord] })
    + `<script data-test="a" type='application/ld+json'>${JSON.stringify([{ ...officialRecord, "@type": ["https://schema.org/Event"] }])}</script>`
    + `<script type="application/ld+json">{broken</script>`;
  const parsed = structuredEvents(html);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /Invalid JSON-LD/);
});

test("official evidence requires an explicit physical US venue and full dates", () => {
  const parsed = parseOfficial(officialRecord, event.url);
  assert.equal(parsed.evidence, "Official structured data");
  assert.equal(parsed.city, "San Jose, CA");
  assert.equal(parseOfficial({ ...officialRecord, location: { "@type": "VirtualLocation" } }, event.url), null);
  assert.equal(parseOfficial({ ...officialRecord, eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode" }, event.url), null);
  assert.equal(parseOfficial({ ...officialRecord, eventStatus: "https://schema.org/EventCancelled" }, event.url), null);
  assert.throws(() => parseOfficial({ ...officialRecord, endDate: undefined }, event.url), /lacks endDate/);
});

test("multiple locations and country objects can describe a hybrid US conference", () => {
  const record = {
    ...officialRecord,
    eventAttendanceMode: "https://schema.org/MixedEventAttendanceMode",
    location: [
      { "@type": "VirtualLocation", url: "https://stream.example" },
      { address: { addressCountry: { name: "United States" }, addressLocality: "Boston", addressRegion: "MA" } },
    ],
  };
  assert.equal(parseOfficial(record, event.url).city, "Boston, MA");
});

test("official matching is edition-aware; previous-year metadata is not confirmation", () => {
  assert.equal(reconcileOfficial(event, [{ ...officialRecord, startDate: "2025-11-03", endDate: "2025-11-05" }], event.url), event);
  assert.equal(reconcileOfficial(event, [{ ...officialRecord, name: "Unrelated AI Conference" }], event.url), event);
  assert.equal(reconcileOfficial(event, [officialRecord], event.url).evidence, "Official structured data");
});

test("unambiguous official corrections override feed dates", () => {
  const corrected = reconcileOfficial(event, [{ ...officialRecord, startDate: "2026-11-04", endDate: "2026-11-06" }], event.url);
  assert.equal(corrected.start, "2026-11-04");
  assert.equal(corrected.end, "2026-11-06");
  assert.equal(corrected.sources.length, 2);
});

test("official cancellation, postponement, online-only, and non-US venue exclude feed entry", () => {
  for (const record of [
    { ...officialRecord, eventStatus: "https://schema.org/EventCancelled" },
    { ...officialRecord, eventStatus: "https://schema.org/EventPostponed" },
    { ...officialRecord, eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode" },
    { ...officialRecord, location: { address: { addressCountry: "Canada", addressLocality: "Toronto" } } },
  ]) assert.equal(reconcileOfficial(event, [record], event.url), null);
});

test("missing venue evidence or ambiguous official records do not remove feed entries", () => {
  assert.equal(reconcileOfficial(event, [{ ...officialRecord, location: undefined }], event.url), event);
  assert.equal(reconcileOfficial(event, [officialRecord, officialRecord], event.url), event);
});

test("official GTC adapter requires explicit year, date range, and San Jose announcement", () => {
  const source = { url: "https://www.nvidia.com/gtc/", textAdapter: "nvidia-gtc", topics: ["AI", "AI infrastructure"] };
  const parsed = textEvents("<p>Save the date for GTC 2027, coming to San Jose on March 15&ndash;18.</p>", source);
  assert.equal(parsed[0].start, "2027-03-15");
  assert.equal(parsed[0].end, "2027-03-18");
  assert.equal(parsed[0].evidence, "Official page evidence");
  assert.equal(textEvents("GTC 2027, coming to London on March 15-18.", source).length, 0);
  assert.equal(textEvents("GTC coming to San Jose on March 15-18.", source).length, 0);
  assert.equal(textEvents("<script>GTC 2027, coming to San Jose on March 15-18.</script>", source).length, 0);
  assert.throws(() => textEvents("GTC 2027, coming to San Jose on February 29-30.", source));
});

test("official announcement adapters read dates and US venues without inferring a future edition", () => {
  const cases = [
    ["aws-reinvent", "AWS re:Invent 2026 | The Premier Cloud and AI Conference | Nov 30-Dec 4, Las Vegas", "2026-11-30", "2026-12-04", "Las Vegas, NV"],
    ["google-cloud-next", "Next returns in 2027 - Stay in the know April 13-15, 2027* Mandalay Bay Convention Center, Las Vegas", "2027-04-13", "2027-04-15", "Las Vegas, NV"],
    ["ai-engineer-code", "<title>AI Engineer Code Summit 2026: AI Engineering Conference, Nov 10-12, San Francisco</title>", "2026-11-10", "2026-11-12", "San Francisco, CA"],
    ["ai-engineer-worldsfair", "JUN 29-JUL 1 2027, SF The World&#x27;s Fair returns to Moscone West", "2027-06-29", "2027-07-01", "San Francisco, CA"],
    ["neurips-atlanta", "NeurIPS 2026 The Fortieth Annual Conference on Neural Information Processing Systems Sydney (Main) Dec 6 - 12 Pricing Registration Atlanta (Satellite) Dec 9 - 13", "2026-12-09", "2026-12-13", "Atlanta, GA"],
    ["cvpr", "CVPR 2027 Seattle WA June 20–25, 2027", "2027-06-20", "2027-06-25", "Seattle, WA"],
  ];
  for (const [textAdapter, html, start, end, city] of cases) {
    const source = { url: event.url, topics: ["AI"], textAdapter };
    const parsed = textEvents(html, source);
    assert.equal(parsed.length, 1, textAdapter);
    assert.equal(parsed[0].start, start, textAdapter);
    assert.equal(parsed[0].end, end, textAdapter);
    assert.equal(parsed[0].city, city, textAdapter);
    assert.equal(textEvents("No dates announced", source).length, 0);
    assert.equal(textEvents(`<script>${html}</script>`, source).length, 0);
  }
  assert.equal(textEvents("CVPR 2027 Seattle WA June 20-25, 2028", { url: event.url, topics: ["AI"], textAdapter: "cvpr" }).length, 0);
});

test("ODSC adapter reads only city/date blocks with explicit years", () => {
  const parsed = textEvents("SAN FRANCISCO OCT 27-29 NEW YORK DEC 2-3, 2026 BOSTON MAY 10-12, 2027", {
    url: "https://odsc.ai/", textAdapter: "odsc", topics: ["AI", "Data infrastructure"],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].city, "New York, NY");
  assert.equal(parsed[1].start, "2027-05-10");
});

test("USENIX table discovers US systems events and excludes non-US and unrelated conferences", () => {
  const row = (name, country, dates = "Apr 12&ndash;14, 2027") => `<tr>
    <td><a href="/conference/srecon27americas"><span class="conference-title">${name}</span></a></td>
    <td class="views-field views-field-field-conference-date">${dates}</td>
    <td><div class="address">Seattle, WA</div><div class="country">${country}</div></td>
  </tr>`;
  const source = { url: "https://www.usenix.org/conferences", textAdapter: "usenix", topics: ["DevOps / SRE"] };
  const parsed = textEvents(row("SREcon27 Americas", "United States") + row("SREcon27 EMEA", "Ireland") + row("Security Conference", "United States"), source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, "https://www.usenix.org/conference/srecon27americas");
  assert.equal(parsed[0].end, "2027-04-14");
  assert.throws(() => textEvents(row("SREcon", "United States", "Dates TBD"), source), /unsupported date/);
  assert.deepEqual(textEvents(row("File and Storage Technologies", "United States"), source)[0].topics, ["Data infrastructure"]);
  const notYetLinked = row("SREcon28 Americas", "United States", "Mar 20&ndash;22, 2028")
    .replace('href="/conference/srecon27americas"', "");
  const nextYear = textEvents(notYetLinked, source)[0];
  assert.equal(nextYear.url, source.url);
  assert.equal(nextYear.start, "2028-03-20");
});

test("name normalization merges year and North America abbreviations", () => {
  assert.equal(normalizedName("KubeCon + CloudNativeCon NA 2026"), normalizedName("KubeCon CloudNativeCon North America"));
  assert.equal(namesMatch("NVIDIA GTC 2027", ["GTC"]), true);
  assert.equal(namesMatch("Unrelated conference", ["AI Engineer"]), false);
});

test("deduplication merges evidence and topics but retains separate dates and cities", () => {
  const official = parseOfficial(officialRecord, event.url);
  const merged = deduplicate([
    event,
    { ...official, topics: ["AI infrastructure"] },
    { ...event, start: "2026-12-01", end: "2026-12-03" },
    { ...event, city: "New York, NY" },
  ]);
  assert.equal(merged.length, 3);
  const confirmed = merged.find((entry) => entry.evidence === "Official structured data");
  assert.deepEqual(confirmed.topics, ["AI", "AI infrastructure", "Data infrastructure"]);
  assert.equal(confirmed.sources.length, 2);
});

test("feed-only end-date conflicts stay visible; authoritative evidence resolves them", () => {
  const conflicts = deduplicate([event, { ...event, end: "2026-11-07" }]);
  assert.equal(conflicts[0].dateConflict, true);
  assert.deepEqual(conflicts[0].alternateEnds, ["2026-11-05", "2026-11-07"]);
  const resolved = deduplicate([...conflicts, parseOfficial(officialRecord, event.url)]);
  assert.equal(resolved[0].dateConflict, false);
  assert.deepEqual(resolved[0].alternateEnds, []);
});

test("bounded concurrency preserves input order", async () => {
  let running = 0;
  let maximum = 0;
  const output = await mapLimit([4, 3, 2, 1, 0], 2, async (value) => {
    running++;
    maximum = Math.max(maximum, running);
    await new Promise((resolve) => setTimeout(resolve, value));
    running--;
    return value * 2;
  });
  assert.ok(maximum <= 2);
  assert.deepEqual(output, [8, 6, 4, 2, 0]);
});

test("HTTP fetch retries transient errors but not 404 responses", async () => {
  let calls = 0;
  const text = await fetchText(event.url, {
    delay: async () => {},
    fetchImpl: async () => ++calls < 3 ? new Response("unavailable", { status: 503 }) : new Response("ready"),
  });
  assert.equal(text, "ready");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(fetchText(event.url, {
    delay: async () => {},
    fetchImpl: async () => { calls++; return new Response("missing", { status: 404 }); },
  }), /HTTP 404/);
  assert.equal(calls, 1);
});

test("network errors retry then fail explicitly", async () => {
  let calls = 0;
  await assert.rejects(fetchText(event.url, {
    delay: async () => {},
    fetchImpl: async () => { calls++; throw new Error("network down"); },
  }), /network down/);
  assert.equal(calls, 3);
});

const config = {
  discovery: {
    name: "test feed",
    rawBaseUrl: "https://feeds.example/",
    topics: ["data", "devops"],
    requiredTopics: ["data", "devops"],
  },
  official: [{
    name: "NVIDIA GTC", names: ["GTC"], url: "https://www.nvidia.com/gtc/",
    topics: ["AI", "AI infrastructure"], textAdapter: "nvidia-gtc",
  }],
};

function fixtures(overrides = {}) {
  const pages = {
    "https://feeds.example/conferences/2026/data.json": JSON.stringify([feedRecord, { ...feedRecord, country: "Canada" }]),
    "https://feeds.example/conferences/2026/devops.json": JSON.stringify([feedRecord]),
    "https://feeds.example/conferences/2027/data.json": JSON.stringify([{ ...feedRecord, name: "AI Outside Window", startDate: "2027-10-17", endDate: "2027-10-18" }]),
    "https://feeds.example/conferences/2027/devops.json": "[]",
    "https://events.example/ai": ld(officialRecord),
    "https://www.nvidia.com/gtc/": "<p>GTC 2027, coming to San Jose on March 15-18.</p>",
    ...overrides,
  };
  const calls = new Map();
  return {
    calls,
    getText: async (url) => {
      calls.set(url, (calls.get(url) ?? 0) + 1);
      if (!(url in pages)) throw new Error(`Unexpected fetch: ${url}`);
      if (pages[url] instanceof Error) throw pages[url];
      return pages[url];
    },
  };
}

const options = { asOf: "2026-10-17", generatedAt: "2026-10-17T12:00:00.000Z" };

test("end-to-end collection discovers, verifies, deduplicates, and sorts rolling events", async () => {
  const fixture = fixtures();
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events.length, 2);
  assert.equal(snapshot.events[0].name, "AI Summit 2026");
  assert.equal(snapshot.events[1].name, "NVIDIA GTC 2027");
  assert.ok(snapshot.events.every((entry) => entry.evidence.startsWith("Official")));
  assert.equal(fixture.calls.get("https://events.example/ai"), 1);
  assert.equal(fixture.calls.has("https://feeds.example/conferences/2026/android.json"), false);
  assert.deepEqual(snapshot.window, { start: "2026-10-17", end: "2027-10-17" });
});

test("failed official pages keep feed entries unverified and expose source failure", async () => {
  const fixture = fixtures({ [event.url]: new Error("HTTP 403"), [config.official[0].url]: new Error("timeout") });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].evidence, "Feed only");
  assert.equal(snapshot.checks.filter((check) => check.status === "unavailable").length, 2);
  assert.match(snapshot.watchlist[0].detail, /timeout/);
});

test("malformed official JSON-LD is reported without pretending dates were verified", async () => {
  const fixture = fixtures({ [event.url]: '<script type="application/ld+json">{broken</script>' });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events[0].evidence, "Feed only");
  assert.ok(snapshot.checks.some((check) => check.status === "warning" && /Invalid JSON-LD/.test(check.detail)));
});

test("any discovery-file failure aborts collection", async () => {
  const fixture = fixtures({ "https://feeds.example/conferences/2026/devops.json": new Error("feed unavailable") });
  await assert.rejects(collect(config, { ...options, getText: fixture.getText }), /feed unavailable/);
});

test("a missing required current-year file aborts instead of silently reducing coverage", async () => {
  const fixture = fixtures({
    "https://feeds.example/conferences/2026/data.json": Object.assign(new Error("HTTP 404"), { status: 404 }),
  });
  await assert.rejects(collect(config, { ...options, getText: fixture.getText }), /HTTP 404/);
});

test("missing future-year files produce explicit coverage warnings", async () => {
  const fixture = fixtures({
    "https://feeds.example/conferences/2027/data.json": Object.assign(new Error("HTTP 404"), { status: 404 }),
    "https://feeds.example/conferences/2027/devops.json": Object.assign(new Error("HTTP 404"), { status: 404 }),
  });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.checks.filter((check) => /not published/.test(check.detail)).length, 2);
});

test("future-year transient failures cannot masquerade as unpublished files", async () => {
  const fixture = fixtures({
    "https://feeds.example/conferences/2027/data.json": Object.assign(new Error("HTTP 503"), { status: 503 }),
  });
  await assert.rejects(collect(config, { ...options, getText: fixture.getText }), /HTTP 503/);
});

test("discovery configuration must retain explicitly required topic coverage", async () => {
  const fixture = fixtures();
  await assert.rejects(collect({
    ...config, discovery: { ...config.discovery, requiredTopics: [] },
  }, { ...options, getText: fixture.getText }), /requiredTopics/);
});

test("empty results fail explicitly", async () => {
  const fixture = fixtures({
    "https://feeds.example/conferences/2026/data.json": "[]",
    "https://feeds.example/conferences/2026/devops.json": "[]",
    "https://www.nvidia.com/gtc/": "<p>No next edition announced.</p>",
  });
  await assert.rejects(collect(config, { ...options, getText: fixture.getText }), /No matching events/);
});

test("Markdown contains required fields, both topic groups, evidence, and refresh health", async () => {
  const fixture = fixtures();
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  const markdown = renderMarkdown(snapshot);
  for (const text of ["2026-10-17T12:00:00.000Z", "2027-10-17", "## Upcoming events", "## Official watchlist", "## Refresh health", "Official structured data", "Official page evidence", "not officially confirmed", "NOTICE"]) assert.ok(markdown.includes(text), text);
  for (const topic of TOPICS) assert.ok(markdown.includes(topic));
  assert.equal(markdown.split("\n").filter((line) => /^\| \d{4}-\d{2}-\d{2}/.test(line)).length, snapshot.events.length);
});

test("untrusted event metadata cannot inject Markdown columns, links, or HTML", () => {
  const snapshot = {
    ...options, window: windowFor(options.asOf), checks: [], watchlist: [],
    events: [{ ...event, name: "[click](javascript:evil)|<script>evil</script>\n# heading", city: "City | <img>", url: "https://events.example/a|b" }],
  };
  const markdown = renderMarkdown(snapshot);
  assert.equal(markdown.includes("<script>"), false);
  assert.equal(markdown.includes("<img>"), false);
  assert.ok(markdown.includes("&#124;"));
  assert.ok(markdown.includes("a%7Cb"));
  const row = markdown.split("\n").find((line) => line.startsWith("| 2026-11-03"));
  assert.equal(row.split("|").length, 7);
});

test("local refresh persists Markdown and preserves it on a later discovery failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conference-tracker-test-"));
  const root = pathToFileURL(`${directory}/`);
  try {
    await writeFile(new URL("sources.json", root), JSON.stringify(config));
    const fixture = fixtures();
    await refresh({ root, ...options, getText: fixture.getText });
    const original = await readFile(new URL("CONFERENCES.md", root), "utf8");
    assert.match(original, /NVIDIA GTC 2027/);
    const broken = fixtures({ "https://feeds.example/conferences/2026/data.json": new Error("discovery down") });
    await assert.rejects(refresh({ root, ...options, getText: broken.getText }), /discovery down/);
    assert.equal(await readFile(new URL("CONFERENCES.md", root), "utf8"), original);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(join(directory, "sources.json"), { force: true });
    await rm(join(directory, "CONFERENCES.md"), { force: true });
    await rm(directory, { recursive: true });
  }
});
