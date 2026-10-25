import test from "node:test";
import assert from "node:assert/strict";
import { ticketDetails } from "./tickets.mjs";
import { renderMarkdown, windowFor } from "./tracker.mjs";

const event = {
  name: "AI Summit 2026", start: "2026-11-03", end: "2026-11-05",
  url: "https://conference.example/2026/", city: "San Jose, CA", country: "US",
  topics: ["AI"], evidence: "Official structured data", sources: ["https://conference.example/2026/"],
};
const record = { "@type": "Event", name: event.name, startDate: event.start };
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const read = (offers, extra = {}) => ticketDetails(event, ld({ ...record, offers, ...extra }), event.url, "2026-10-25");

test("explicit free prices are recognized, but absent/blank prices are never free", () => {
  assert.equal(read({ "@type": "Offer", price: 0 }).price.label, "Free (listed offers)");
  assert.equal(read(undefined, { isAccessibleForFree: true }).price.label, "Free (official event metadata)");
  assert.equal(read(undefined, { isAccessibleForFree: false }).price, null);
  for (const price of [undefined, "", null, "Free", -1, "1,299", "TBA"]) {
    assert.equal(read({ "@type": "Offer", price, priceCurrency: "USD" }).price, null);
  }
  assert.equal(read({ "@type": "Offer", price: "299" }).price, null);
  assert.equal(read(undefined).price, null);
});

test("numeric and aggregate offers retain currency, ranges, and registration links", () => {
  const tickets = read({ "@type": "AggregateOffer", lowPrice: "299", highPrice: "599", priceCurrency: "USD", url: "../register?x=1&y=2" });
  assert.equal(tickets.price.label, "USD 299 - USD 599 (listed offers; types vary)");
  assert.equal(tickets.registrationUrl, "https://conference.example/register?x=1&y=2");
  assert.equal(tickets.price.url, event.url);
  assert.match(read({ price: 300, priceCurrency: "usd" }).price.label, /^USD 300/);
  assert.throws(() => read({ lowPrice: 100, highPrice: 50, priceCurrency: "USD" }), /inverted/);
});

test("mixed ticket currencies are not converted or combined into a fictitious range", () => {
  const tickets = read([
    { price: "100.50", priceCurrency: "USD" }, { price: 200, priceCurrency: "USD" },
    { price: 90, priceCurrency: "EUR" }, { price: 0 },
  ]);
  assert.match(tickets.price.label, /EUR 90/);
  assert.match(tickets.price.label, /USD 100\.5 - USD 200/);
  assert.match(tickets.price.label, /Free/);
});

test("expired, not-yet-valid, sold-out and discontinued offers are not current prices", () => {
  for (const extra of [
    { validThrough: "2026-10-24" }, { priceValidUntil: "2026-10-24" }, { validFrom: "2026-10-26" },
    { availability: "https://schema.org/SoldOut" }, { availability: "https://schema.org/Discontinued" },
  ]) assert.equal(read({ price: "99", priceCurrency: "USD", ...extra }).price, null);
  assert.notEqual(read({ price: "99", priceCurrency: "USD", validThrough: "2026-10-25" }).price, null);
});

test("other years, unrelated events, products, and ambiguous Event records do not supply prices", () => {
  const offer = { price: 100, priceCurrency: "USD", url: "/register" };
  assert.equal(read(offer, { startDate: "2025-11-03" }).price, null);
  assert.equal(read(offer, { startDate: "2026-06-03" }).price, null);
  assert.equal(read(offer, { name: "Sponsor Packages" }).price, null);
  assert.equal(ticketDetails(event, ld({ "@type": "Product", name: event.name, offers: offer })).price, null);
  const duplicate = ld({ ...record, offers: offer }) + ld({ ...record, offers: offer });
  assert.equal(ticketDetails(event, duplicate).price, null);
  const oldEdition = ld({ ...record, startDate: "2025-11-03", offers: offer }) + '<a href="/2025/register">Register</a>';
  assert.equal(ticketDetails(event, oldEdition).registrationUrl, null);
});

test("official anchors resolve relative links, query entities, fragments and button text", () => {
  const html = '<a href="/2026/pricing">Pricing</a><a href="../register?x=1&amp;y=2#tickets"><span>Register now</span></a>';
  const details = ticketDetails(event, html);
  assert.equal(details.registrationUrl, "https://conference.example/register?x=1&y=2#tickets");
  assert.equal(details.pricingUrl, "https://conference.example/2026/pricing");
  assert.equal(details.price, null);
  assert.equal(ticketDetails(event, '<button class="hero event-register__btn">REGISTER</button>').registrationUrl, event.url);
});

test("application links are labeled accurately and unrelated product pricing is excluded", () => {
  const tickets = ticketDetails(event, '<a href="/pricing">Pricing</a><a href="/apply">Apply to attend</a>');
  assert.equal(tickets.pricingUrl, null);
  assert.equal(tickets.registrationUrl, "https://conference.example/apply");
  assert.equal(tickets.registrationLabel, "Apply to attend");
});

test("script/comment pseudo-links, newsletters, sponsorships and unsafe URLs are not registration", () => {
  const html = '<script><a href="/bad">Register</a></script><!--<a href="/bad2">Register</a>-->'
    + '<a href="/newsletter">Register</a><a href="/sponsor">Registration</a>'
    + '<a href="#">Register</a><a href="/updates">Register interest</a><a href="mailto:a@example.com">Register</a>';
  assert.equal(ticketDetails(event, html).registrationUrl, null);
  assert.throws(() => ticketDetails(event, '<a href="javascript:evil()">Register</a>'), /Unsupported/);
  assert.throws(() => read({ price: 0, url: "javascript:evil()" }), /Unsupported/);
});

test("AWS price reader requires current event year and exact full-pass pricing copy", () => {
  const aws = { ...event, name: "AWS re:Invent 2026", url: "https://aws.amazon.com/events/reinvent/", start: "2026-11-30" };
  const html = "<title>AWS re:Invent 2026 Pricing - Passes &amp; Registration</title><p>Full price — $2,499</p>";
  const priced = ticketDetails(aws, html, "https://aws.amazon.com/events/reinvent/pricing/", "2026-10-25");
  assert.equal(priced.price.label, "USD 2,499 (full pass)");
  assert.equal(ticketDetails({ ...aws, start: "2027-11-30" }, html, aws.url).price, null);
  assert.equal(ticketDetails(aws, "<p>Hotel room $249 and sponsorship $10,000</p>", aws.url).price, null);
  assert.equal(ticketDetails(aws, html, "https://not-aws.example/pricing/").price, null);
});

test("KubeCon price reader selects active corporate tiers, not expired early-bird or student rates", () => {
  const kube = { ...event, name: "KubeCon + CloudNativeCon North America", start: "2026-11-09", end: "2026-11-12" };
  const markup = ld({ ...record, name: kube.name, startDate: kube.start })
    + "<p>Corporate Early Bird Apr 8-May 12, 2026 $1199 USD Expired Standard May 13-Sep 2, 2026 $1798 USD Expired Late Sep 3-Nov 12, 2026 $2278 USD Individual Early Bird $599 USD</p>"
    + "<p>Corporate Early Bird Apr 8-May 12, 2026 $999 USD Expired Late Sep 3-Nov 12, 2026 $1899 USD Individual Early Bird $399 USD Academic $200 USD</p>";
  const url = "https://events.linuxfoundation.org/kubecon-cloudnativecon-north-america/register/";
  const details = ticketDetails(kube, markup, url, "2026-10-25");
  assert.equal(details.price.label, "USD 1,899 conference-only; USD 2,278 all-access (corporate; tax extra)");
  assert.equal(ticketDetails(kube, markup, url, "2026-11-13").price, null);
  assert.equal(ticketDetails({ ...kube, name: "Maintainer Summit" }, markup, url, "2026-10-25").price, null);
});

test("IBM, AI DevCon and AI Engineer readers require matching source and edition context", () => {
  const ibm = { ...event, name: "IBM TechXchange 2026", url: "https://www.ibm.com/community/ibm-techxchange-conference/" };
  assert.equal(ticketDetails(ibm, "IBM TechXchange 2026 Passes and pricing Full conference pass USD 1,599").price.label, "USD 1,599 (full conference pass)");
  assert.equal(ticketDetails({ ...ibm, start: "2027-10-26" }, "IBM TechXchange 2026 Full conference pass USD 1,599").price, null);
  const devcon = { ...event, name: "AI DevCon NYC", url: "https://tessl.io/devcon" };
  const text = "AI Native DevCon NYC: November 2026 Conference only $300 Full 3-day ticket $400";
  assert.equal(ticketDetails(devcon, text).price.label, "$300 conference-only; $400 full 3-day (currency as published)");
  assert.equal(ticketDetails(devcon, "Parking $15. Speakers receive a complimentary ticket.").price, null);
  const aie = { ...event, name: "AI Engineer Code Summit 2026", url: "https://ai.engineer/code", start: "2026-11-10" };
  const aieHtml = ld({ ...record, name: aie.name, startDate: aie.start }) + "Ticket pricing // if approved Regular NOW $1,299 + fees Final $1,499";
  assert.match(ticketDetails(aie, aieHtml).price.label, /^\$1,299 regular \(application approval/);
  assert.equal(ticketDetails({ ...aie, start: "2027-11-10" }, aieHtml).price, null);
});

test("Markdown escapes ticket text and clearly marks cached tickets stale", () => {
  const markdown = renderMarkdown({
    generatedAt: "2026-10-25T12:00:00Z", window: windowFor("2026-10-25"), checks: [], watchlist: [],
    events: [{
      ...event, price: { label: "USD 99 | <script>bad</script>", url: "https://conference.example/pricing" },
      registrationUrl: "https://conference.example/register", stale: true,
      lastVerifiedAt: "2026-10-20T12:00:00Z", ticketCheckedAt: "2026-10-20T12:00:00Z",
    }],
  });
  assert.equal(markdown.includes("<script>"), false);
  assert.ok(markdown.includes("&#124;"));
  assert.match(markdown, /stale; checked 2026-10-20T12:00:00Z/);
  const row = markdown.split("\n").find((line) => line.startsWith("| 2026-11-03"));
  assert.equal(row.split("|").length, 9);
});
