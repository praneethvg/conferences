import { dateOnly, httpUrl, normalizedName, structuredEvents } from "./tracker.mjs";

function cleanHtml(html) {
  return html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
}

function textOf(html) {
  return cleanHtml(html).replace(/<[^>]*>/g, " ")
    .replace(/&amp;|&#0*38;/gi, "&").replace(/&nbsp;|&#0*160;/gi, " ")
    .replace(/&ndash;|&mdash;|[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
}

function ticketUrl(value, base) {
  const url = new URL(value, base);
  httpUrl(url.href);
  return url.href;
}

function matchingRecords(event, records) {
  const name = normalizedName(event.name);
  return records.filter((record) => typeof record.name === "string"
    && normalizedName(record.name) === name
    && typeof record.startDate === "string" && record.startDate.slice(0, 10) === event.start);
}

function amount(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function money(value, currency) {
  return `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`;
}

function offerDetails(record, pageUrl, asOf) {
  const offers = [record.offers].flat().filter(Boolean);
  const prices = [];
  let registrationUrl = null;
  for (const offer of offers) {
    if (typeof offer !== "object") throw new Error("Invalid official ticket offer");
    if (offer.validFrom && dateOnly(offer.validFrom) > asOf) continue;
    if ((offer.validThrough && dateOnly(offer.validThrough) < asOf)
      || (offer.priceValidUntil && dateOnly(offer.priceValidUntil) < asOf)) continue;
    if (/SoldOut|Discontinued/.test(offer.availability ?? "")) continue;
    if (offer.url && !registrationUrl) registrationUrl = ticketUrl(offer.url, pageUrl);
    const low = amount(offer.price ?? offer.lowPrice);
    const high = amount(offer.highPrice ?? offer.price ?? offer.lowPrice);
    if (low === null || high === null) continue;
    if (high < low) throw new Error("Official ticket offer has an inverted price range");
    const currency = typeof offer.priceCurrency === "string" ? offer.priceCurrency.toUpperCase() : offer.priceCurrency;
    if (low !== 0 && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) continue;
    if (high !== 0 && (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))) continue;
    prices.push({ low, high, currency: currency ?? null });
  }
  let label = null;
  if (!offers.length && record.isAccessibleForFree === true) label = "Free (official event metadata)";
  if (prices.length && prices.every((price) => price.high === 0)) label = "Free (listed offers)";
  else if (prices.length) {
    const currencies = [...new Set(prices.map((price) => price.currency))].sort();
    label = `${currencies.map((currency) => {
      if (currency === null) return "Free";
      const matching = prices.filter((price) => price.currency === currency);
      const low = Math.min(...matching.map((price) => price.low));
      const high = Math.max(...matching.map((price) => price.high));
      return low === high ? money(low, currency) : `${money(low, currency)} - ${money(high, currency)}`;
    }).join("; ")} (listed offers; types vary)`;
  }
  return { price: label ? { label, url: pageUrl } : null, registrationUrl };
}

export function ticketDetails(event, html, pageUrl = event.url, asOf = new Date().toISOString().slice(0, 10)) {
  const details = { price: null, registrationUrl: null, registrationLabel: "Register", pricingUrl: null };
  const allRecords = structuredEvents(html).events;
  const records = matchingRecords(event, allRecords);
  const otherEdition = allRecords.some((record) => typeof record.name === "string"
    && normalizedName(record.name) === normalizedName(event.name) && typeof record.startDate === "string");
  if (!records.length && otherEdition) return details;
  if (records.length === 1) Object.assign(details, offerDetails(records[0], pageUrl, asOf));
  const clean = cleanHtml(html);
  for (const anchor of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const label = textOf(anchor[2]);
    const registration = /^(?:register(?: now| here| today)?|registration|buy (?:a pass|tickets?)|get tickets|tickets)$/i.test(label);
    const application = /^(?:apply now|apply to attend)$/i.test(label);
    const pricing = /^(?:pricing|ticket prices|registration fees|registration rates|pricing and registration)$/i.test(label);
    if (!registration && !application && !pricing) continue;
    const href = anchor[1].match(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i);
    if (!href) continue;
    const raw = (href[1] ?? href[2] ?? href[3]).replace(/&amp;|&#0*38;/g, "&");
    if (raw === "#" || /^(?:mailto|tel):/i.test(raw)) continue;
    const url = ticketUrl(raw, pageUrl);
    if (/\/(?:login|signin|sponsor|newsletter|hotel|notify)(?:\/|[?#]|$)/i.test(new URL(url).pathname)) continue;
    if ((registration || application) && !details.registrationUrl) {
      details.registrationUrl = url;
      details.registrationLabel = application ? "Apply to attend" : "Register";
    }
    const scope = new URL(event.url).pathname.replace(/\/$/, "");
    const withinEvent = !scope || new URL(url).pathname.startsWith(`${scope}/`) || new URL(url).pathname === scope;
    if (pricing && !details.pricingUrl && (withinEvent || label.toLowerCase() !== "pricing")) details.pricingUrl = url;
  }
  if (!details.registrationUrl && /<button\b[^>]*class=["'][^"']*\bevent-register__btn\b[^"']*["'][^>]*>\s*REGISTER\s*<\/button>/i.test(clean)) {
    details.registrationUrl = ticketUrl(pageUrl, pageUrl);
  }
  const text = textOf(html);
  const year = event.start.slice(0, 4);
  if (new URL(pageUrl).hostname === "aws.amazon.com" && normalizedName(event.name) === normalizedName("AWS re:Invent")) {
    const edition = text.match(/\bAWS re:Invent (20\d{2}) Pricing\b/);
    const price = text.match(/\bFull price\s*-\s*\$(\d[\d,]*(?:\.\d{2})?)\b/);
    if (edition?.[1] === year && price) {
      details.price = { label: `${money(Number(price[1].replace(/,/g, "")), "USD")} (full pass)`, url: pageUrl };
    }
  }
  if (new URL(pageUrl).hostname === "www.ibm.com" && /^ibmtechxchange$/.test(normalizedName(event.name))
    && text.includes(`IBM TechXchange ${year}`)) {
    const price = text.match(/\bFull conference pass USD ([\d,]+(?:\.\d{2})?)\b/);
    if (price) details.price = { label: `${money(Number(price[1].replace(/,/g, "")), "USD")} (full conference pass)`, url: pageUrl };
  }
  if (new URL(pageUrl).hostname === "tessl.io" && normalizedName(event.name) === "aidevconnyc"
    && text.includes(`AI Native DevCon NYC: November ${year}`)) {
    const conference = text.match(/\bConference only \$(\d[\d,]*)\b/);
    const full = text.match(/\bFull 3-day ticket \$(\d[\d,]*)\b/);
    if (conference && full) details.price = {
      label: `$${conference[1]} conference-only; $${full[1]} full 3-day (currency as published)`, url: pageUrl,
    };
  }
  if (new URL(pageUrl).hostname === "ai.engineer" && normalizedName(event.name) === "aiengineercodesummit" && records.length === 1) {
    const price = text.match(/\bTicket pricing \/\/ if approved Regular NOW \$(\d[\d,]*) \+ fees\b/);
    if (price) details.price = {
      label: `$${price[1]} regular (application approval; fees extra; currency as published)`, url: pageUrl,
    };
  }
  const kubeName = normalizedName("KubeCon CloudNativeCon North America");
  if (new URL(pageUrl).hostname === "events.linuxfoundation.org" && normalizedName(event.name) === kubeName
    && records.length === 1 && new URL(pageUrl).pathname.endsWith("/register/")) {
    const groups = [...text.matchAll(/\bCorporate (?<rates>.*?)(?=Individual Early Bird)/g)];
    const prices = groups.map((group) => activeCorporatePrice(group.groups.rates, asOf, year));
    if (prices.length === 2 && prices.every((price) => price !== null)) {
      details.price = {
        label: `${money(prices[1], "USD")} conference-only; ${money(prices[0], "USD")} all-access (corporate; tax extra)`,
        url: pageUrl,
      };
    }
  }
  return details;
}

function activeCorporatePrice(text, asOf, year) {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const rates = [...text.matchAll(/(?:Early Bird|Standard|Late) ([A-Za-z]+) (\d{1,2})\s*-\s*(?:([A-Za-z]+) )?(\d{1,2}), (20\d{2}) \$(\d[\d,]*(?:\.\d{2})?) USD( Expired)?/g)];
  for (const rate of rates) {
    if (rate[5] !== year || rate[7]) continue;
    const startMonth = months.indexOf(rate[1].toLowerCase().slice(0, 3)) + 1;
    const endMonth = rate[3] ? months.indexOf(rate[3].toLowerCase().slice(0, 3)) + 1 : startMonth;
    const iso = (month, day) => dateOnly(`${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`);
    if (iso(startMonth, rate[2]) <= asOf && asOf <= iso(endMonth, rate[4])) return Number(rate[6].replace(/,/g, ""));
  }
  return null;
}
