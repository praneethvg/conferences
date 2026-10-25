export const TOPICS = [
  "AI",
  "AI infrastructure",
  "Cloud / Kubernetes",
  "DevOps / SRE",
  "Data infrastructure",
];

const RULES = [
  ["AI", /\b(ai|aie|artificial intelligence|machine learning|deep learning|data science|llms?|generative|genai|agentic|agents|neurips|icml|iclr|cvpr|odsc|pytorch|gtc)\b/i],
  ["AI infrastructure", /\b(ai infra(?:structure)?|mlops|llmops|inference|gpus?|model serving|ai factor(?:y|ies)|ray summit|pytorch|gtc|supercomputing|hot chips|data cent(?:er|re)|datacent(?:er|re)|open compute|ocp)\b/i],
  ["Cloud / Kubernetes", /\b(cloud|cloudnativecon|cloudnative|kubecon|kubernetes|kcd|aws|azure|gcp|reinvent|re invent|hashiconf|containers?|compute)\b/i],
  ["DevOps / SRE", /\b(devops(?:days|con)?|sre(?:con)?|platform(?:con)?|observability|monitorama|on call|incident|sev0)\b/i],
  ["Data infrastructure", /\b(data|databases?|postgres(?:ql)?|pg data|snowflake|databricks|kafka|streaming|analytics|sql|fabric|jupyter)\b/i],
];

const TOPIC_HINTS = {
  data: "Data infrastructure",
  devops: "DevOps / SRE",
  sre: "DevOps / SRE",
  networking: "Cloud / Kubernetes",
};

export function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) {
    throw new Error(`Expected an ISO date, got ${JSON.stringify(value)}`);
  }
  const day = value.slice(0, 10);
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== day
    || (value.length > 10 && !Number.isFinite(Date.parse(value)))) {
    throw new Error(`Invalid calendar date: ${day}`);
  }
  return day;
}

export function windowFor(day) {
  const start = dateOnly(day);
  const [year, month, date] = start.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year + 1, month, 0)).getUTCDate();
  const end = `${year + 1}-${String(month).padStart(2, "0")}-${String(Math.min(date, lastDay)).padStart(2, "0")}`;
  return { start, end };
}

export function isUS(country) {
  const value = typeof country === "object" && country !== null ? country.name ?? country["@id"] : country;
  return typeof value === "string" && /^(us|usa|unitedstates|unitedstatesofamerica)$/.test(value.toLowerCase().replace(/[\s.]/g, ""));
}

export function topicsFor(name, hint, extra = []) {
  const text = name.replace(/[-_:]/g, " ");
  const matches = RULES.filter(([, rule]) => rule.test(text)).map(([topic]) => topic);
  if (TOPIC_HINTS[hint]) matches.push(TOPIC_HINTS[hint]);
  return TOPICS.filter((topic) => matches.includes(topic) || extra.includes(topic));
}

export function httpUrl(value) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Unsupported event URL: ${value}`);
  }
  url.hash = "";
  return url.href;
}

export function normalizedName(name) {
  return name.toLowerCase()
    .replace(/\baie\s+code\s+summit(?:\s+sf)?\b/g, "ai engineer code summit")
    .replace(/\bnorth america\b|\bna\b/g, " northamerica ")
    .replace(/\b(?:19|20)\d{2}\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function namesMatch(name, aliases) {
  const normalized = normalizedName(name);
  return aliases.some((alias) => {
    const target = normalizedName(alias);
    return target.length >= 3 && normalized.includes(target);
  });
}

export function inWindow(event, window) {
  return event.end >= window.start && event.start < window.end;
}

function normalizeEvent(event) {
  if (typeof event.name !== "string" || !event.name.trim()) throw new Error("Event name is missing");
  const start = dateOnly(event.start);
  const end = dateOnly(event.end ?? event.start);
  if (end < start) throw new Error(`${event.name}: end date precedes start date`);
  return { ...event, name: event.name.trim(), start, end, url: httpUrl(event.url) };
}

export function parseFeed(records, source) {
  if (!Array.isArray(records)) throw new Error(`${source.name}: expected an array`);
  const events = [];
  for (const record of records) {
    if (!record || typeof record !== "object" || typeof record.name !== "string" || typeof record.startDate !== "string") {
      throw new Error(`${source.name}: invalid conference record`);
    }
    if (!isUS(record.country) || !record.city?.trim()) continue;
    if (/cancel|postpon|delay|virtual/i.test(record.status ?? "")) continue;
    const topics = topicsFor(record.name, source.topic);
    if (!topics.length) continue;
    events.push(normalizeEvent({
      name: record.name,
      start: record.startDate,
      end: record.endDate,
      city: record.city.trim(),
      country: "US",
      url: record.url,
      topics,
      evidence: "Feed only",
      sources: [source.url],
    }));
  }
  return events;
}

export function parseDevelopersFeed(records, source) {
  if (!Array.isArray(records) || !records.length) throw new Error(`${source.name}: expected a nonempty event array`);
  const events = [];
  for (const record of records) {
    if (!record || typeof record.name !== "string" || !Array.isArray(record.date) || !record.date.length) {
      throw new Error(`${source.name}: invalid developers.events record`);
    }
    if (!isUS(record.country) || typeof record.city !== "string" || !record.city.trim()
      || /cancel|postpon|delay|virtual/i.test(record.status ?? "")) continue;
    if (!record.date.every((value) => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()))) {
      throw new Error(`${source.name}: ${record.name}: invalid date timestamps`);
    }
    if (record.tags !== undefined && (!Array.isArray(record.tags) || record.tags.some((tag) =>
      !tag || typeof tag.key !== "string" || typeof tag.value !== "string"))) {
      throw new Error(`${source.name}: ${record.name}: invalid tags`);
    }
    const tags = (record.tags ?? []).filter((tag) => ["tech", "topic"].includes(tag.key)).map((tag) => tag.value);
    const topics = topicsFor([record.name, ...tags].join(" "));
    if (!topics.length) continue;
    const dates = record.date.map((value) => dateOnly(new Date(value).toISOString())).sort();
    events.push(normalizeEvent({
      name: record.name,
      start: dates[0],
      end: dates.at(-1),
      city: record.city.trim(),
      country: "US",
      url: record.hyperlink,
      topics,
      evidence: "Feed only",
      sources: [source.url],
    }));
  }
  return events;
}

function decodeEntities(text) {
  return text.replace(/&(?:amp|quot|apos|lt|gt|nbsp|ndash|mdash);|&#(?:x[0-9a-f]+|\d+);/gi, (entity) => {
    const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&ndash;": "-", "&mdash;": "-" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3), 16) : parseInt(entity.slice(2), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

export function structuredEvents(html) {
  const events = [];
  const warnings = [];
  function walk(value) {
    if (!value || typeof value !== "object") return;
    const types = [value["@type"]].flat();
    if (types.some((type) => typeof type === "string" && /(?:^|\/)(?:Event|BusinessEvent|EducationEvent|ConferenceEvent)$/.test(type))) {
      events.push(value);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === "object") walk(child);
    }
  }
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(script[1])) continue;
    try {
      walk(JSON.parse(script[2]));
    } catch (error) {
      warnings.push(`Invalid JSON-LD: ${error.message}`);
    }
  }
  return { events, warnings };
}

export function parseOfficial(record, pageUrl, topics = []) {
  if (/EventCancelled|EventPostponed/.test(record.eventStatus ?? "")) return null;
  if (/OnlineEventAttendanceMode/.test(record.eventAttendanceMode ?? "")) return null;
  const locations = [record.location].flat().filter(Boolean);
  const place = locations.find((location) => isUS(location.address?.addressCountry) && location.address?.addressLocality);
  if (!place) return null;
  if (!record.endDate) throw new Error("Official Event lacks endDate; cannot verify its full date range");
  return normalizeEvent({
    name: record.name,
    start: record.startDate,
    end: record.endDate,
    city: [place.address.addressLocality, place.address.addressRegion].filter(Boolean).join(", "),
    country: "US",
    url: pageUrl,
    topics: topicsFor(record.name, undefined, topics),
    evidence: "Official structured data",
    sources: [pageUrl],
  });
}

function visibleText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "))
    .replace(/[\u2013\u2014]/g, "-").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim();
}

function announcement(source, name, groups, city, topics = source.topics, url = source.url) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const startMonth = months.indexOf(groups.month.toLowerCase().slice(0, 3)) + 1;
  const endMonth = groups.endMonth ? months.indexOf(groups.endMonth.toLowerCase().slice(0, 3)) + 1 : startMonth;
  if (!startMonth || !endMonth) throw new Error(`Unrecognized announcement month: ${groups.month}/${groups.endMonth}`);
  const iso = (year, month, day) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return normalizeEvent({
    name,
    start: iso(groups.year, startMonth, groups.start),
    end: iso(Number(groups.year) + (endMonth < startMonth ? 1 : 0), endMonth, groups.end),
    city,
    country: "US",
    url,
    topics,
    evidence: "Official page evidence",
    sources: [source.url],
  });
}

function usenixEvents(html, source) {
  const events = [];
  for (const match of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = match[1];
    const title = row.match(/<span\b[^>]*class=["']conference-title["'][^>]*>([\s\S]*?)<\/span>/i);
    if (!title || !/srecon|storage|networked systems|operating systems|distributed systems|annual technical/i.test(visibleText(title[1]))) continue;
    const country = row.match(/<div\b[^>]*class=["']country["'][^>]*>([\s\S]*?)<\/div>/i);
    if (!country || !isUS(visibleText(country[1]))) continue;
    const address = row.match(/<div\b[^>]*class=["']address["'][^>]*>([\s\S]*?)<\/div>/i);
    const dates = row.match(/<td\b[^>]*class=["'][^"']*views-field-field-conference-date[^"']*["'][^>]*>([\s\S]*?)<\/td>/i);
    const href = row.match(/href=["'](\/conference\/[^"'?#]+)["']/i);
    const range = dates && visibleText(dates[1]).match(/^(?<month>[A-Za-z]+)\.?\s+(?<start>\d{1,2})\s*-\s*(?:(?<endMonth>[A-Za-z]+)\.?\s+)?(?<end>\d{1,2}),\s*(?<year>20\d{2})$/);
    if (!address || !range) throw new Error("USENIX conference row has unsupported date/venue markup");
    const acronym = row.match(/<div\b[^>]*class=["']acronym["'][^>]*>([\s\S]*?)<\/div>/i);
    const name = [acronym && visibleText(acronym[1]), visibleText(title[1])].filter(Boolean).join(" ");
    const topics = /srecon/i.test(name) ? ["DevOps / SRE"]
      : /storage/i.test(name) ? ["Data infrastructure"] : ["Cloud / Kubernetes"];
    const url = href ? new URL(href[1], source.url).href : source.url;
    events.push(announcement(source, name, range.groups, visibleText(address[1]), topics, url));
  }
  return events;
}

function metaScaleEvents(html, source) {
  const events = [];
  const cards = [...html.matchAll(/<span\b[^>]*class=["']title-text["'][^>]*>([\s\S]*?)<\/span>/gi)];
  for (let index = 0; index < cards.length; index++) {
    const title = visibleText(cards[index][1]).replace(/\s*-\s*PAST EVENT$/i, "");
    if (!/^(?:AI & DATA|SYSTEMS & RELIABILITY|NETWORKING|PRODUCT)$/i.test(title)) continue;
    const body = html.slice(cards[index].index + cards[index][0].length, cards[index + 1]?.index ?? html.length);
    const fields = [...body.matchAll(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi)].slice(0, 2).map((match) => visibleText(match[1]));
    const range = fields[0]?.match(/^(?<month>[A-Za-z]+) (?<start>\d{1,2})(?:\s*-\s*(?:(?<endMonth>[A-Za-z]+) )?(?<end>\d{1,2}))?, (?<year>20\d{2})$/);
    if (!range) throw new Error(`Meta @Scale ${title}: unsupported date markup`);
    const venue = fields[1] ?? "";
    if (/\bonline|virtual\b/i.test(venue)) continue;
    const usVenue = venue.match(/(?:^|, )(?<city>Menlo Park|Bellevue|Santa Clara), (?<region>CA|California|WA|Washington)$/);
    if (!usVenue) throw new Error(`Meta @Scale ${title}: unsupported US venue: ${venue}`);
    const topics = topicsFor(`${title} ${visibleText(body)}`);
    const href = [...body.matchAll(/href=["']([^"']+)["']/gi)].map((match) => new URL(decodeEntities(match[1]), source.url))
      .find((url) => url.origin === new URL(source.url).origin && url.pathname.startsWith("/events/"));
    const groups = { ...range.groups, end: range.groups.end ?? range.groups.start };
    events.push(announcement(source, `Meta @Scale: ${title} ${groups.year}`, groups,
      `${usVenue.groups.city}, ${/^(?:CA|California)$/.test(usVenue.groups.region) ? "CA" : "WA"}`,
      topics, href?.href ?? source.url));
  }
  return events;
}

export function textEvents(html, source) {
  if (!source.textAdapter) return [];
  if (source.textAdapter === "usenix") return usenixEvents(html, source);
  if (source.textAdapter === "meta-atscale") return metaScaleEvents(html, source);
  const text = visibleText(html);
  if (source.textAdapter === "odsc") {
    return [...text.matchAll(/\b(?<city>BOSTON|NEW YORK) (?<month>[A-Z]+) (?<start>\d{1,2})-(?<end>\d{1,2}), (?<year>20\d{2})\b/gi)]
      .map((match) => announcement(source, `ODSC ${match.groups.city.toUpperCase() === "BOSTON" ? "East" : "AI NYC"} ${match.groups.year}`, match.groups,
        match.groups.city.toUpperCase() === "BOSTON" ? "Boston, MA" : "New York, NY"));
  }
  const adapters = {
    "nvidia-gtc": {
      pattern: /\bGTC (?<year>20\d{2}),? coming to San Jose on (?<month>[A-Za-z]+) (?<start>\d{1,2})\s*-\s*(?<end>\d{1,2})\b/i,
      name: "NVIDIA GTC", city: "San Jose, CA",
    },
    "aws-reinvent": {
      pattern: /\bAWS re:Invent (?<year>20\d{2}) \| [^|]{1,100} \| (?<month>[A-Za-z]+)\.? (?<start>\d{1,2})\s*-\s*(?:(?<endMonth>[A-Za-z]+)\.? )?(?<end>\d{1,2}), Las Vegas\b/i,
      name: "AWS re:Invent", city: "Las Vegas, NV",
    },
    "google-cloud-next": {
      pattern: /\bNext returns in (?<year>20\d{2}) - Stay in the know (?<month>[A-Za-z]+) (?<start>\d{1,2})-(?<end>\d{1,2}), \k<year>\*? Mandalay Bay Convention Center, Las Vegas\b/i,
      name: "Google Cloud Next", city: "Las Vegas, NV",
    },
    "ai-engineer-code": {
      pattern: /\bAI Engineer Code Summit (?<year>20\d{2}): AI Engineering Conference, (?<month>[A-Za-z]+) (?<start>\d{1,2})-(?<end>\d{1,2}), San Francisco\b/i,
      name: "AI Engineer Code Summit", city: "San Francisco, CA",
    },
    "ai-engineer-worldsfair": {
      pattern: /\b(?<month>[A-Z]{3}) (?<start>\d{1,2})-(?:(?<endMonth>[A-Z]{3}) )?(?<end>\d{1,2}) (?<year>20\d{2}), SF The World's Fair returns to Moscone West\b/i,
      name: "AI Engineer World's Fair", city: "San Francisco, CA",
    },
    "neurips-atlanta": {
      pattern: /\bNeurIPS (?<year>20\d{2}) The .{1,100}?Annual Conference on Neural Information Processing Systems.{0,180}?Atlanta \(Satellite\) (?<month>[A-Za-z]+) (?<start>\d{1,2})\s*-\s*(?<end>\d{1,2})\b/i,
      name: "NeurIPS Atlanta satellite", city: "Atlanta, GA",
    },
    cvpr: {
      pattern: /\bCVPR (?<year>20\d{2}) Seattle WA (?<month>[A-Za-z]+) (?<start>\d{1,2})-(?<end>\d{1,2}), \k<year>\b/i,
      name: "CVPR", city: "Seattle, WA",
    },
  };
  const adapter = adapters[source.textAdapter];
  if (!adapter) throw new Error(`Unknown text adapter: ${source.textAdapter}`);
  const match = text.match(adapter.pattern);
  return match ? [announcement(source, `${adapter.name} ${match.groups.year}`, match.groups, adapter.city)] : [];
}

export function reconcileOfficial(event, records, pageUrl) {
  const matching = records.filter((record) => typeof record.name === "string"
    && normalizedName(record.name) === normalizedName(event.name)
    && typeof record.startDate === "string"
    && record.startDate.slice(0, 4) === event.start.slice(0, 4));
  const exact = matching.filter((record) => record.startDate.slice(0, 10) === event.start && (record.endDate ?? record.startDate).slice(0, 10) === event.end);
  const candidates = exact.length ? exact : matching;
  if (candidates.length !== 1) return event;
  const record = candidates[0];
  const official = parseOfficial(record, pageUrl, event.topics);
  if (!official) {
    const countries = [record.location].flat().filter(Boolean).map((location) => location.address?.addressCountry).filter(Boolean);
    const excluded = /EventCancelled|EventPostponed/.test(record.eventStatus ?? "")
      || /OnlineEventAttendanceMode/.test(record.eventAttendanceMode ?? "")
      || (countries.length > 0 && !countries.some(isUS));
    return excluded ? null : event;
  }
  return { ...official, sources: [...new Set([...event.sources, pageUrl])] };
}

export function deduplicate(events) {
  const merged = [];
  const rank = { "Feed only": 0, "Official page evidence": 1, "Official structured data": 2 };
  const canonicalUrl = (value) => {
    const url = new URL(httpUrl(value));
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}`;
  };
  const sameCity = (a, b) => {
    const parts = (city) => city.toLowerCase().split(",").map((part) => part.replace(/[^a-z0-9]/g, ""));
    const first = parts(a);
    const second = parts(b);
    return first[0] === second[0] && (!first[1] || !second[1] || first[1] === second[1]);
  };
  for (const event of events) {
    const name = normalizedName(event.name);
    const matches = merged.map((existing, index) => {
      if (existing.start !== event.start) return -1;
      const otherName = normalizedName(existing.name);
      const sameUrl = canonicalUrl(existing.url) === canonicalUrl(event.url);
      if (name === otherName && (sameCity(existing.city, event.city) || sameUrl)) return index;
      const related = Math.min(name.length, otherName.length) >= 8
        && (normalizedName(event.name.split(":")[0]) === otherName || normalizedName(existing.name.split(":")[0]) === name);
      return related && sameUrl && sameCity(existing.city, event.city) ? index : -1;
    }).filter((index) => index !== -1);
    if (matches.length !== 1) {
      merged.push({ ...event });
      continue;
    }
    const index = matches[0];
    const existing = merged[index];
    const preferred = rank[event.evidence] > rank[existing.evidence] ? event : existing;
    const conflict = event.end !== existing.end && rank[event.evidence] === 0 && rank[existing.evidence] === 0;
    const locationConflict = !sameCity(existing.city, event.city) && preferred.evidence === "Feed only";
    merged[index] = {
      ...preferred,
      topics: TOPICS.filter((topic) => existing.topics.includes(topic) || event.topics.includes(topic)),
      sources: [...new Set([...existing.sources, ...event.sources])].sort(),
      dateConflict: preferred.evidence === "Feed only" && Boolean(existing.dateConflict || event.dateConflict || conflict),
      alternateEnds: preferred.evidence === "Feed only" ? [...new Set([...(existing.alternateEnds ?? []), ...(event.alternateEnds ?? []), ...(conflict ? [existing.end, event.end] : [])])].sort() : [],
      locationConflict: preferred.evidence === "Feed only" && Boolean(existing.locationConflict || event.locationConflict || locationConflict),
      alternateCities: preferred.evidence === "Feed only" ? [...new Set([...(existing.alternateCities ?? []), ...(event.alternateCities ?? []), ...(locationConflict ? [existing.city, event.city] : [])])].sort() : [],
    };
  }
  return merged.sort((a, b) => a.start.localeCompare(b.start) || a.name.localeCompare(b.name));
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await mapper(items[current], current);
    }
  }));
  return results;
}

export async function fetchText(url, { fetchImpl = fetch, attempts = 3, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  httpUrl(url);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetchImpl(url, {
        headers: { "User-Agent": "us-ai-infra-conferences/1.0", Accept: "application/json, text/html;q=0.9" },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        const error = Object.assign(new Error(`HTTP ${response.status} for ${url}`), { status: response.status });
        if (![408, 429].includes(response.status) && response.status < 500) throw Object.assign(error, { permanent: true });
        throw error;
      }
      const text = await response.text();
      if (text.length > 10_000_000) throw Object.assign(new Error(`Response exceeds 10 MB: ${url}`), { permanent: true });
      return text;
    } catch (error) {
      lastError = error;
      if (error.permanent || attempt + 1 === attempts) break;
      await delay(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function cell(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\|/g, "&#124;").replace(/\[/g, "&#91;").replace(/\]/g, "&#93;")
    .replace(/[*_`\\]/g, (character) => `\\${character}`).replace(/[\r\n]+/g, " ");
}

function link(label, url) {
  httpUrl(url);
  return `[${cell(label)}](<${new URL(url).href.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C")}>)`;
}

export function renderMarkdown(snapshot) {
  const { window, generatedAt, events, checks, watchlist } = snapshot;
  const warnings = checks.filter((check) => check.status !== "ok");
  const verified = events.filter((event) => event.evidence !== "Feed only" && !event.stale).length;
  const feedOnly = events.filter((event) => event.evidence === "Feed only").length;
  const stale = events.filter((event) => event.stale).length;
  const lines = [
    "# US AI and infrastructure conferences",
    "",
    `Last refreshed: **${generatedAt}**. Window: **${window.start} <= event start < ${window.end} (UTC)**; ongoing events are also included.`,
    "",
    `**${events.length} events** | **${verified} with current official date evidence** | **${feedOnly} feed-only** | **${stale} retained from unavailable sources** | **${warnings.length} source checks needing attention**`,
    "",
    `Ticket coverage: **${events.filter((event) => event.price).length} prices found** | **${events.filter((event) => event.registrationUrl).length} registration/application links found** (including any explicitly stale entries below).`,
    "",
    "AI and infrastructure receive equal priority: neither has a quota or ranking advantage. Events can belong to multiple topics.",
    "",
    "| Topic | Events |",
    "| --- | ---: |",
    ...TOPICS.map((topic) => `| ${topic} | ${events.filter((event) => event.topics.includes(topic)).length} |`),
    "",
    "## Upcoming events",
    "",
    "Feed-only dates are community-reported, **not officially confirmed**. An official link or successful page fetch alone is not date verification. Retained entries from unavailable sources are explicitly marked stale with their last verification date. Consult the organizer before booking travel.",
    "",
    "Ticket prices are separately checked against official pages, not inferred from feed dates. Listed offers can span ticket types; eligibility, taxes and availability may vary. \"Not found\" does not mean free. Follow the price or registration link for current terms.",
    "",
    "| Dates | Conference / official site | US location | Topics | Price | Registration | Date evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...events.map((event) => {
      const dates = event.start === event.end ? event.start : `${event.start} - ${event.end}`;
      const sources = event.sources.map((url, index) => link(`source ${index + 1}`, url)).join(", ");
      const conflict = event.dateConflict ? `; **conflicting end dates: ${event.alternateEnds.map(cell).join(", ")}**` : "";
      const evidence = event.stale ? `**Stale: source unavailable**; last verified ${cell(event.lastVerifiedAt)}` : cell(event.evidence);
      const location = event.locationConflict ? `**Location conflict:** ${event.alternateCities.map(cell).join(" / ")}` : cell(event.city);
      const price = event.price ? link(event.price.label, event.price.url)
        : event.pricingUrl ? `Not found; ${link("check pricing", event.pricingUrl)}` : "Not found";
      const registration = event.registrationUrl ? link(event.registrationLabel ?? "Register", event.registrationUrl) : "Not found";
      const staleTickets = event.stale && (event.price || event.registrationUrl) ? ` (stale; checked ${cell(event.ticketCheckedAt ?? "previous refresh")})` : "";
      return `| ${dates}${event.start < window.start ? " (ongoing)" : ""} | ${link(event.name, event.url)} | ${location} | ${event.topics.join(", ")} | ${price}${staleTickets} | ${registration}${staleTickets} | ${evidence}${conflict}; ${sources} |`;
    }),
    ...(events.length ? [] : ["", "**No matching events found.** This does not mean no US conferences exist. Review source coverage below."]),
    "",
    "## Official watchlist",
    "",
    "These recurring conferences are checked separately from the discovery feed. This is **not a list of confirmed upcoming US editions**: dates or US venues may be unannounced, outside the window, or unavailable in machine-readable form. Previous-year dates are never rolled forward.",
    "",
    "| Conference family | Topics | Latest check |",
    "| --- | --- | --- |",
    ...watchlist.map((entry) => `| ${link(entry.name, entry.url)} | ${entry.topics.join(", ")} | ${cell(entry.detail)} |`),
    "",
    "## Refresh health",
    "",
    "Discovery failures stop the refresh before replacing this file. Official-page failures do not remove feed entries; they remain explicitly feed-only. Previously verified official-only entries are retained as stale when a source is unavailable, not presented as freshly verified. Individual source checks appear below, including failures and unsupported page formats.",
    "",
    "<details>",
    "<summary>Source checks</summary>",
    "",
    "| Source | Status | Detail |",
    "| --- | --- | --- |",
    ...checks.map((check) => `| ${link(check.name, check.url)} | ${cell(check.status)} | ${cell(check.detail)} |`),
    "",
    "</details>",
    "",
    "## Coverage and attribution",
    "",
    "- Discovery: [confs.tech / conference-data](https://github.com/tech-conferences/conference-data), community-maintained data under its [MIT license](https://github.com/tech-conferences/conference-data/blob/main/LICENSE.md). Records are filtered, normalized, classified, and sometimes corrected using official sources. See [NOTICE](./NOTICE).",
    "- Discovery: [developers.events / Developers Conferences Agenda](https://github.com/scraly/developers-conferences-agenda) by Aurelie Vache and contributors, content under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). Its records are filtered, normalized, classified, merged, and sometimes corrected here. **Noncommercial use only under that license; do not assume this combined dataset is MIT-licensed.** Per-row source links preserve provenance; see [NOTICE](./NOTICE).",
    "- Official verification: matching Schema.org Event data or a narrowly scoped, tested official-page adapter. Missing or ambiguous evidence stays unverified.",
    "- US in-person and hybrid events only; virtual-only events and confirmed cancelled/postponed events are excluded.",
    "- Public feeds are not exhaustive and can contain errors. Conferences absent from the feed or without supported official metadata can be missed. Add sources or adapters to improve coverage.",
    "- Refresh weekly or on demand using GitHub Actions; see [README](./README.md). Scheduled GitHub runs can be delayed. If a workflow fails, the last successful snapshot remains here: check its timestamp and the Actions tab.",
    "",
  ];
  return lines.join("\n");
}
