import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TOPICS, dateOnly, windowFor, isUS, topicsFor, httpUrl, inWindow, normalizedName,
  namesMatch, parseFeed, parseDevelopersFeed, structuredEvents, parseOfficial, textEvents,
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
const developersSource = { type: "developers-events", name: "developers.events", url: "https://feeds.example/all-events.json" };
const developersRecord = {
  name: feedRecord.name, hyperlink: feedRecord.url, country: "USA", city: feedRecord.city,
  date: [Date.UTC(2026, 10, 3), Date.UTC(2026, 10, 5)],
  status: "open", tags: [{ key: "topic", value: "artificial-intelligence" }],
};

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

test("developers.events normalizes timestamp ranges, single days, and typed topic tags", () => {
  const parsed = parseDevelopersFeed([
    developersRecord,
    { ...developersRecord, name: "Compute Summit", date: [Date.UTC(2027, 0, 20)] },
    { ...developersRecord, name: "Unknown Summit", tags: [{ key: "tech", value: "kubernetes" }], date: [...developersRecord.date].reverse() },
    { ...developersRecord, name: "Unknown Summit", tags: [{ key: "language", value: "ai" }] },
  ], developersSource);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { ...event, topics: ["AI"], sources: [developersSource.url] });
  assert.equal(parsed[1].start, "2027-01-20");
  assert.equal(parsed[1].end, "2027-01-20");
  assert.deepEqual(parsed[2].topics, ["Cloud / Kubernetes"]);
  assert.equal(parsed[2].start, "2026-11-03");
});

test("developers.events excludes virtual, delayed, postponed, cancelled, non-US and unlocated records", () => {
  const records = [
    developersRecord,
    ...["Canceled", "Virtualized", "Postponed in Automn", "Delayed to Automn"].map((status) => ({ ...developersRecord, status })),
    { ...developersRecord, country: "Canada" },
    { ...developersRecord, city: "" },
    { ...developersRecord, country: "Online" },
  ];
  assert.equal(parseDevelopersFeed(records, developersSource).length, 1);
});

test("developers.events rejects empty feeds, invalid timestamps, tags, URLs and schema drift", () => {
  for (const records of [
    [], {}, [null], [{ ...developersRecord, date: [] }], [{ ...developersRecord, date: ["2026-11-03"] }],
    [{ ...developersRecord, date: [NaN] }], [{ ...developersRecord, date: [1e16] }],
    [{ ...developersRecord, tags: ["ai"] }], [{ ...developersRecord, hyperlink: "javascript:alert(1)" }],
  ]) assert.throws(() => parseDevelopersFeed(records, developersSource));
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

function metaCard(title, date, venue, description, url = "https://atscaleconference.com/events/product-2026/") {
  return `<span class="title-text"><p><strong>${title}</strong></p></span>
    <div class="body-box"><div class="body-text"><p><strong>${date}</strong><br><strong>${venue}</strong></p>
    <p>${description}</p></div><a href="${url}">View Event</a></div>`;
}

test("Meta @Scale adapter reads independent event cards with exact dates, venues and topics", () => {
  const source = { url: "https://atscaleconference.com/", textAdapter: "meta-atscale" };
  const html = metaCard("PRODUCT", "October 28, 2026", "Meta Campus, Menlo Park, CA", "Building AI-native products.")
    + metaCard("AI &amp; DATA - PAST EVENT", "June 17, 2026", "Meta Campus, Menlo Park, CA", "AI infrastructure.")
    + metaCard("SYSTEMS &amp; RELIABILITY", "June 25-26, 2027", "Meydenbauer Center, Bellevue, Washington", "GPU inference and SRE.")
    + metaCard("NETWORKING", "August 25, 2027", "Santa Clara Convention Center, Santa Clara, CA", "Cloud networking.");
  const parsed = textEvents(html, source);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].name, "Meta @Scale: PRODUCT 2026");
  assert.equal(parsed[0].start, "2026-10-28");
  assert.equal(parsed[0].end, "2026-10-28");
  assert.equal(parsed[0].city, "Menlo Park, CA");
  assert.deepEqual(parsed[0].topics, ["AI"]);
  assert.equal(parsed[0].url, "https://atscaleconference.com/events/product-2026/");
  assert.equal(parsed[1].start, "2026-06-17");
  assert.equal(parsed[2].end, "2027-06-26");
  assert.equal(parsed[2].city, "Bellevue, WA");
  assert.ok(parsed[2].topics.includes("AI infrastructure"));
  assert.ok(parsed[3].topics.includes("Cloud / Kubernetes"));
  assert.equal(parsed.filter((entry) => inWindow(entry, windowFor("2026-10-25"))).length, 3);
});

test("Meta @Scale cannot invent dates or US venues from unrelated or unsupported markup", () => {
  const source = { url: "https://atscaleconference.com/", textAdapter: "meta-atscale" };
  assert.equal(textEvents("<p>October 28, 2026 Meta Campus, Menlo Park, CA</p>", source).length, 0);
  assert.throws(() => textEvents(metaCard("PRODUCT", "October 28", "Meta Campus, Menlo Park, CA", "AI"), source), /unsupported date/);
  assert.throws(() => textEvents(metaCard("PRODUCT", "October 28, 2026", "London, UK", "AI"), source), /unsupported US venue/);
  assert.equal(textEvents(metaCard("PRODUCT", "October 28, 2026", "Virtual", "AI"), source).length, 0);
});

const ocpSource = {
  name: "Open Compute Project events", url: "https://www.opencompute.org/events/",
  topics: ["AI infrastructure"], names: ["OCP"], textAdapter: "ocp-calendar",
};

function ocpCard({
  name = "2027 OCP Global Summit", date = "October 4&ndash;7, 2027", location = "San Francisco, CA",
  url = "/events/ocp-summit/2027-ocp-global-summit/", host = "ocp",
} = {}) {
  return `<li class="ocp-content-card ocp-content-card--event is-entire-card-clickable">
    <div><span class="ocp-content-card__tag ocp-content-card__tag--${host}">OCP event</span></div>
    <div><h4 class="ocp-content-card__heading ocp-reveal"><a href="${url}">${name}</a></h4>
    <div>Summary with unrelated dates and locations is not metadata.</div></div>
    <dl><div><dt class="ocp-content-card__meta-label">Date:</dt><dd><span>${date}</span></dd></div>
    ${location === null ? "" : `<div><dt>Location:</dt><dd><span>${location}</span></dd></div>`}</dl>
  </li>`;
}

test("OCP calendar discovers the current global summit and other hosted US infrastructure events", () => {
  const html = '<nav><a href="/events/ocp-summit/2026-ocp-global-summit/">2026 OCP Global Summit</a></nav>'
    + ocpCard()
    + ocpCard({ name: "Digital Infrastructure World", date: "February 3–4, 2027", location: "San Jose, California", url: "/events/ocp-tech-day/digital-infrastructure-world/" })
    + ocpCard({ name: "Future OCP Summit", date: "September 25-28, 2028", location: "Seattle, Washington", url: "/events/ocp-summit/future-summit/" });
  const parsed = textEvents(html, ocpSource);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], {
    name: "2027 OCP Global Summit", start: "2027-10-04", end: "2027-10-07",
    city: "San Francisco, CA", country: "US", topics: ["AI infrastructure"],
    url: "https://www.opencompute.org/events/ocp-summit/2027-ocp-global-summit/",
    evidence: "Official page evidence", sources: [ocpSource.url],
  });
  assert.equal(parsed[1].city, "San Jose, CA");
  assert.equal(parsed[2].city, "Seattle, WA");
  assert.equal(parsed.filter((entry) => inWindow(entry, windowFor("2026-10-26"))).length, 2);
});

test("OCP calendar excludes non-US editions, virtual events and third-party appearances", () => {
  const parsed = textEvents(
    ocpCard({ name: "OCP EMEA Summit", location: "Hamburg, Germany" })
    + ocpCard({ name: "OCP APAC Summit", location: "Taipei, Taiwan" })
    + ocpCard({ name: "OCP Canada Tech Day", location: "Toronto, Canada" })
    + ocpCard({ name: "Educational Webinar", location: null })
    + ocpCard({ name: "Virtual Summit", location: "Online" })
    + ocpCard({ name: "OCP at SC26", location: "Chicago, IL", host: "third-party" }),
    ocpSource,
  );
  assert.deepEqual(parsed, []);
});

test("OCP date parsing handles single-day and cross-month events without rolling years forward", () => {
  const parsed = textEvents(
    ocpCard({ date: "October 4, 2027", location: "Washington, DC, United States" })
    + ocpCard({ date: "September 30–October 3, 2027" })
    + ocpCard({ name: "2026 OCP Global Summit", date: "October 12-15, 2026" }),
    ocpSource,
  );
  assert.equal(parsed[0].start, "2027-10-04");
  assert.equal(parsed[0].end, "2027-10-04");
  assert.equal(parsed[0].city, "Washington, DC");
  assert.equal(parsed[1].end, "2027-10-03");
  assert.equal(parsed[2].start, "2026-10-12");
  assert.equal(inWindow(parsed[2], windowFor("2026-10-26")), false);
});

test("OCP markup drift, invalid dates and unsafe event links are reported instead of guessed", () => {
  for (const html of [
    "<p>2027 OCP Global Summit October 4-7 San Francisco, CA</p>",
    `<script>${ocpCard()}</script>`,
    `<!--${ocpCard()}-->`,
    ocpCard({ date: "Dates TBD" }),
    ocpCard({ date: "February 30, 2027" }),
    ocpCard({ location: "California" }),
    ocpCard({ location: "San Francisco, United States" }),
    ocpCard({ url: "https://unrelated.example/events/" }),
  ]) assert.throws(() => textEvents(html, ocpSource));
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
    { ...event, city: "New York, NY", url: "https://events.example/new-york" },
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

test("cross-feed duplicates merge provenance across city formatting and official subtitles", () => {
  const fromDevelopers = parseDevelopersFeed([developersRecord], developersSource)[0];
  const merged = deduplicate([
    event, { ...fromDevelopers, city: "San Jose", url: "http://www.events.example/ai/" },
    { ...parseOfficial(officialRecord, event.url), name: "AI Summit 2026: Infrastructure Conference" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].evidence, "Official structured data");
  assert.ok(merged[0].sources.includes(source.url));
  assert.ok(merged[0].sources.includes(developersSource.url));
});

test("same-site colocated events, different cities/states and ambiguous matches stay distinct", () => {
  assert.equal(deduplicate([event, { ...event, name: "AI Summit Workshop" }]).length, 2);
  assert.equal(deduplicate([event, { ...event, name: "ProductWorld" }]).length, 2);
  assert.equal(deduplicate([event, { ...event, city: "San Jose, NM", url: "https://events.example/new-mexico" }]).length, 2);
  assert.equal(deduplicate([
    { ...event, city: "Springfield, MA", url: "https://events.example/ma" },
    { ...event, city: "Springfield, IL", url: "https://events.example/il" },
    { ...event, city: "Springfield", url: "https://events.example/springfield" },
  ]).length, 3);
});

test("same conference URL with conflicting feed locations stays one visibly conflicted entry", () => {
  const merged = deduplicate([event, { ...event, city: "Brooklyn, NY" }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].locationConflict, true);
  assert.deepEqual(merged[0].alternateCities, ["Brooklyn, NY", "San Jose, CA"]);
  const resolved = deduplicate([...merged, parseOfficial(officialRecord, event.url)]);
  assert.equal(resolved[0].locationConflict, false);
  const aliases = deduplicate([
    { ...event, name: "AIE CODE Summit SF 2026" },
    { ...event, name: "AI Engineer Code Summit 2026" },
  ]);
  assert.equal(aliases.length, 1);
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
  discovery: [{
    type: "confs-tech",
    name: "test feed",
    rawBaseUrl: "https://feeds.example/",
    topics: ["data", "devops"],
    requiredTopics: ["data", "devops"],
  }],
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

test("collection includes OCP Global Summit from the ongoing official calendar with dated evidence", async () => {
  const fixture = fixtures({
    [ocpSource.url]: ocpCard(),
    "https://www.opencompute.org/events/ocp-summit/2027-ocp-global-summit/": "<p>2027 OCP Global Summit</p>",
  });
  const snapshot = await collect({ ...config, official: [...config.official, ocpSource] }, {
    ...options, getText: fixture.getText,
  });
  const summit = snapshot.events.find((entry) => entry.name === "2027 OCP Global Summit");
  assert.ok(summit);
  assert.equal(summit.start, "2027-10-04");
  assert.equal(summit.end, "2027-10-07");
  assert.equal(summit.evidence, "Official page evidence");
  assert.ok(snapshot.checks.some((check) => check.url === ocpSource.url && check.status === "ok"));
  assert.match(renderMarkdown(snapshot), /\| 2027-10-04 - 2027-10-07 \| \[2027 OCP Global Summit\]/);
  const unsupported = fixtures({ [ocpSource.url]: "<p>New calendar markup</p>" });
  const withWarning = await collect({ ...config, official: [...config.official, ocpSource] }, {
    ...options, getText: unsupported.getText,
  });
  assert.ok(withWarning.checks.some((check) => check.url === ocpSource.url && check.status === "warning"));
});

test("collection unions both feeds and official sources, retaining each source URL", async () => {
  const multi = { ...config, discovery: [...config.discovery, developersSource] };
  const fixture = fixtures({ [developersSource.url]: JSON.stringify([developersRecord, {
    ...developersRecord, name: "AI Native Summit", hyperlink: "https://events.example/new",
    date: [Date.UTC(2027, 3, 10)],
  }]), "https://events.example/new": "<p>Official date metadata unavailable</p>" });
  const snapshot = await collect(multi, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events.length, 3);
  const shared = snapshot.events.find((entry) => entry.start === "2026-11-03");
  assert.ok(shared.sources.includes(developersSource.url));
  assert.equal(fixture.calls.get(event.url), 1);
  assert.ok(snapshot.checks.some((check) => check.name === developersSource.name && /2 matching US/.test(check.detail)));
  const markdown = renderMarkdown(snapshot);
  assert.match(markdown, /CC BY-NC 4\.0/);
  assert.match(markdown, /Noncommercial use only/);
});

test("collection reads ticket offers and follows pricing links without conflating date evidence", async () => {
  const fixture = fixtures({
    [event.url]: ld({ ...officialRecord, offers: { "@type": "Offer", price: "0", priceCurrency: "USD", url: "/register" } }),
    [config.official[0].url]: '<p>GTC 2027, coming to San Jose on March 15-18.</p><a href="/gtc/tickets">Pricing</a><a href="/register">Register</a>',
    "https://www.nvidia.com/gtc/tickets": ld({
      ...officialRecord, name: "NVIDIA GTC 2027", startDate: "2027-03-15", endDate: "2027-03-18",
      offers: { "@type": "Offer", price: "199", priceCurrency: "USD" },
    }),
  });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events[0].price.label, "Free (listed offers)");
  assert.equal(snapshot.events[0].registrationUrl, "https://events.example/register");
  assert.equal(snapshot.events[1].price.label, "USD 199 (listed offers; types vary)");
  assert.equal(snapshot.events[1].price.url, "https://www.nvidia.com/gtc/tickets");
  assert.equal(snapshot.events[1].evidence, "Official page evidence");
  assert.equal(snapshot.events[1].ticketCheckedAt, options.generatedAt);
  assert.equal(fixture.calls.get(event.url), 1);
});

test("pricing-page outages preserve conferences and their usable registration/pricing links", async () => {
  const fixture = fixtures({
    [event.url]: ld(officialRecord) + '<a href="/ai/pricing">Pricing</a><a href="/registration">Register now</a>',
    "https://events.example/ai/pricing": new Error("HTTP 403"),
  });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  const priced = snapshot.events[0];
  assert.equal(priced.price, null);
  assert.equal(priced.registrationUrl, "https://events.example/registration");
  assert.ok(snapshot.checks.some((check) => /pricing$/.test(check.name) && check.status === "unavailable"));
  const markdown = renderMarkdown(snapshot);
  assert.match(markdown, /Not found; \[check pricing\]/);
  assert.match(markdown, /\| Price \| Registration \|/);
});

test("application links found on pricing pages keep their application-only label", async () => {
  const fixture = fixtures({
    [event.url]: ld(officialRecord) + '<a href="/ai/pricing">Pricing</a>',
    "https://events.example/ai/pricing": '<a href="/apply">Apply to attend</a>',
  });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events[0].registrationUrl, "https://events.example/apply");
  assert.equal(snapshot.events[0].registrationLabel, "Apply to attend");
});

test("blocked official ticket pages retain cached ticket details without advancing their check timestamp", async () => {
  const initial = fixtures({
    [event.url]: ld({ ...officialRecord, offers: { price: 199, priceCurrency: "USD", url: "/register" } }),
  });
  const previous = await collect(config, { ...options, getText: initial.getText });
  const blocked = fixtures({ [event.url]: new Error("HTTP 403") });
  const snapshot = await collect(config, {
    ...options, generatedAt: "2026-10-26T12:00:00Z", previousEvents: previous.events, getText: blocked.getText,
  });
  const retained = snapshot.events[0];
  assert.equal(retained.evidence, "Feed only");
  assert.equal(retained.ticketsStale, true);
  assert.equal(retained.price.label, "USD 199 (listed offers; types vary)");
  assert.equal(retained.registrationUrl, "https://events.example/register");
  assert.equal(retained.ticketCheckedAt, options.generatedAt);
  assert.match(renderMarkdown(snapshot), /stale; checked 2026-10-17T12:00:00\.000Z/);
  const recovered = await collect(config, {
    ...options, generatedAt: "2026-10-27T12:00:00Z", previousEvents: snapshot.events, getText: initial.getText,
  });
  assert.notEqual(recovered.events[0].ticketsStale, true);
  assert.equal(recovered.events[0].ticketCheckedAt, "2026-10-27T12:00:00Z");
});

test("failed or malformed additional feeds fail explicitly rather than silently reducing coverage", async () => {
  for (const result of [new Error("developers feed down"), "{}", "[]", "{broken"]) {
    const fixture = fixtures({ [developersSource.url]: result });
    await assert.rejects(collect({ ...config, discovery: [...config.discovery, developersSource] }, {
      ...options, getText: fixture.getText,
    }));
  }
});

test("discovery rejects unsupported adapters and empty source configuration", async () => {
  const fixture = fixtures();
  for (const discovery of [[], [{ type: "unknown" }]]) {
    await assert.rejects(collect({ ...config, discovery }, { ...options, getText: fixture.getText }), /discovery|source type/);
  }
});

test("failed official pages keep feed entries unverified and expose source failure", async () => {
  const fixture = fixtures({ [event.url]: new Error("HTTP 403"), [config.official[0].url]: new Error("timeout") });
  const snapshot = await collect(config, { ...options, getText: fixture.getText });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.events[0].evidence, "Feed only");
  assert.equal(snapshot.checks.filter((check) => check.status === "unavailable").length, 2);
  assert.match(snapshot.watchlist[0].detail, /timeout/);
});

test("unavailable official sources retain previously verified events as visibly stale", async () => {
  const initial = fixtures();
  const previous = await collect(config, { ...options, getText: initial.getText });
  const outage = fixtures({ [config.official[0].url]: new Error("HTTP 403") });
  const snapshot = await collect(config, {
    ...options, generatedAt: "2026-10-24T12:00:00.000Z", getText: outage.getText, previousEvents: previous.events,
  });
  assert.equal(snapshot.events.length, 2);
  const retained = snapshot.events.find((entry) => entry.name === "NVIDIA GTC 2027");
  assert.equal(retained.stale, true);
  assert.equal(retained.lastVerifiedAt, options.generatedAt);
  const markdown = renderMarkdown(snapshot);
  assert.match(markdown, /Stale: source unavailable/);
  assert.match(markdown, /1 retained from unavailable sources/);
  assert.match(markdown, /1 with current official date evidence/);
});

test("retained official events age out, and recovered sources clear stale status", async () => {
  const initial = fixtures();
  const previous = await collect(config, { ...options, getText: initial.getText });
  const expired = { ...previous.events[1], start: "2026-10-01", end: "2026-10-02" };
  const outage = fixtures({ [config.official[0].url]: new Error("HTTP 403") });
  const snapshot = await collect(config, { ...options, getText: outage.getText, previousEvents: [expired] });
  assert.equal(snapshot.events.some((entry) => entry.stale), false);
  const recovered = await collect(config, {
    ...options, generatedAt: "2026-10-24T12:00:00.000Z", getText: initial.getText,
    previousEvents: previous.events.map((entry) => ({ ...entry, stale: true })),
  });
  assert.ok(recovered.events.every((entry) => !entry.stale && entry.lastVerifiedAt === "2026-10-24T12:00:00.000Z"));
});

test("fresh official cancellations do not resurrect cached events from another blocked source", async () => {
  const initial = fixtures();
  const previous = await collect(config, { ...options, getText: initial.getText });
  const cached = { ...previous.events[0], sources: [...previous.events[0].sources, config.official[0].url] };
  const fixture = fixtures({
    [config.official[0].url]: new Error("HTTP 403"),
    [event.url]: ld({ ...officialRecord, eventStatus: "https://schema.org/EventCancelled" }),
  });
  await assert.rejects(collect(config, { ...options, getText: fixture.getText, previousEvents: [cached] }), /No matching events/);
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
    ...config, discovery: [{ ...config.discovery[0], requiredTopics: [] }],
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
  assert.equal(row.split("|").length, 9);
});

test("local refresh persists cache, retains outage entries, and preserves Markdown on critical failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "conference-tracker-test-"));
  const root = pathToFileURL(`${directory}/`);
  try {
    await writeFile(new URL("sources.json", root), JSON.stringify(config));
    const fixture = fixtures();
    await refresh({ root, ...options, getText: fixture.getText });
    const original = await readFile(new URL("CONFERENCES.md", root), "utf8");
    assert.match(original, /NVIDIA GTC 2027/);
    const cache = JSON.parse(await readFile(new URL("conference-cache.json", root), "utf8"));
    assert.equal(cache.events.length, 2);
    const outage = fixtures({ [config.official[0].url]: new Error("HTTP 403") });
    await refresh({ root, ...options, generatedAt: "2026-10-24T12:00:00.000Z", getText: outage.getText });
    const retained = await readFile(new URL("CONFERENCES.md", root), "utf8");
    assert.match(retained, /Stale: source unavailable/);
    const retainedCache = JSON.parse(await readFile(new URL("conference-cache.json", root), "utf8"));
    assert.equal(retainedCache.events.find((entry) => entry.name === "NVIDIA GTC 2027").lastVerifiedAt, options.generatedAt);
    const broken = fixtures({ "https://feeds.example/conferences/2026/data.json": new Error("discovery down") });
    await assert.rejects(refresh({ root, ...options, getText: broken.getText }), /discovery down/);
    assert.equal(await readFile(new URL("CONFERENCES.md", root), "utf8"), retained);
    await writeFile(new URL("conference-cache.json", root), JSON.stringify({ version: 2, events: [] }));
    await assert.rejects(refresh({ root, ...options, getText: fixture.getText }), /Invalid conference cache schema/);
    assert.equal(await readFile(new URL("CONFERENCES.md", root), "utf8"), retained);
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(join(directory, "sources.json"), { force: true });
    await rm(join(directory, "CONFERENCES.md"), { force: true });
    await rm(join(directory, "conference-cache.json"), { force: true });
    await rm(directory, { recursive: true });
  }
});
