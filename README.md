# US AI and infrastructure conference tracker

Read **[CONFERENCES.md](./CONFERENCES.md)** for the latest successful snapshot of US conferences in the next rolling 12 months.

No dashboard, database, paid API, API key, or third-party Node packages are required. AI and infrastructure are equally important; there are no per-topic caps. Coverage includes AI research and applications, GPUs/inference/training, cloud/Kubernetes, DevOps/SRE, data infrastructure, and data centers.

## Refresh in GitHub

The **Refresh conferences** workflow runs on Mondays at **13:15 UTC**.

For an immediate refresh:

1. Open **Actions** in this repository.
2. Select **Refresh conferences**.
3. Select **Run workflow** on the default branch.
4. After it succeeds, open [CONFERENCES.md](./CONFERENCES.md).

The workflow tests the tracker, collects events, and commits the generated Markdown and its factual event cache. Its built-in `GITHUB_TOKEN` has write access in that job; no personal access token or search secret is needed. GitHub-hosted runner usage remains subject to your account's private-repository Actions allowance. Organization policies can restrict Actions or token write access.

Schedules run only from the default branch and may be delayed. If you later make the repository public, GitHub can disable scheduled workflows after 60 days of repository inactivity; check Actions if updates stop. Failed refreshes leave the previous successful list intact. **Always check the list's refresh timestamp** and workflow status rather than assuming the list is current.

## Refresh locally

Requires Node.js 22 or newer:

```sh
npm test
npm run refresh
```

There is nothing to install. The command atomically replaces [CONFERENCES.md](./CONFERENCES.md) only after collection succeeds and saves [conference-cache.json](./conference-cache.json) for future source outages. It does not commit or push local changes.

For a reproducible date window:

```sh
npm run refresh -- --as-of 2026-10-17
```

The window starts on the selected UTC calendar day and ends just before the same calendar date next year. Ongoing conferences are included; events beginning at the upper boundary are excluded. Leap-day anniversaries clamp to February 28. No previous-year dates are automatically shifted into a future year.

## How discovery and verification work

1. Read complementary discovery feeds: current- and next-year topic files from [confs.tech](https://github.com/tech-conferences/conference-data) and the public [developers.events JSON feed](https://developers.events/all-events.json). New events added to either source are discovered on subsequent runs. No GitHub API quota or credentials are involved.
2. Normalize each feed's schema (including developers.events millisecond timestamps and topic tags). Keep US physical/hybrid events whose dates overlap the window. Classify by conference name and relevant feed topics, then merge duplicates while retaining every contributing source URL. Matching names and dates can merge city-only/state-qualified locations; matching official URLs can also reconcile name subtitles. Different dates or distinct conference URLs/locations stay separate; conflicting feed-only end dates or locations on the same event are flagged.
3. Fetch each event's official link and the recurring conferences in [sources.json](./sources.json). Reuse requests to the same URL and limit concurrency and retries.
4. Verify matching Schema.org JSON-LD Event records, including dates and a US physical venue. Official corrections take precedence when the name and edition match unambiguously.
5. Use narrowly scoped official-page adapters where needed: Meta @Scale, GTC, AWS re:Invent, Google Cloud Next, AI Engineer, ODSC, CVPR, the NeurIPS Atlanta satellite, and the USENIX systems-conference table. Each requires explicit edition, date, and venue evidence. The Meta reader handles separate AI/Data, Systems/Reliability, Networking, and AI-themed Product event cards; it never rolls past dates forward and currently recognizes explicit Menlo Park/Santa Clara, California and Bellevue, Washington venues. Unsupported venues or markup are reported, not guessed.
6. Read event-specific ticket offers and registration/pricing links from official pages, following linked pricing pages when a price has not been found.
7. Generate a chronological table with **Price** and **Registration** columns, topic counts, recurring-event watchlist, source attribution, and detailed refresh health.

**Feed only** means community-reported dates, not official confirmation. Fetching a page successfully does not verify its dates. Unsupported, malformed, ambiguous, or blocked official pages remain visible in the health section. Feed-only conflicts are flagged rather than hidden.

### Prices and registration

- Explicit Schema.org Event `offers` provide free/paid prices, currencies, offer ranges and ticket links. Offers must match the event name and year; expired, future-valid, sold-out and discontinued offers are not reported as current prices.
- Multiple offers are labeled as a range with **types vary**, not assumed to be a standard full-conference pass. Different currencies stay separate. Missing currency on a nonzero price is not guessed.
- Dedicated readers also support AWS re:Invent and IBM TechXchange full-pass prices, AI DevCon ticket types, AI Engineer Code Summit's current application-approved rate, and KubeCon North America's active corporate rates (conference-only and all-access, excluding tax). They do not quote expired early-bird prices or subsidized academic rates as standard prices.
- Registration links come from explicit official-page buttons/links or matched Event offers; they are not guessed URL paths. Application-only events are labeled **Apply to attend**. Some links point to an event page with a registration form or button instead of an external checkout. Same-site registration pages are also checked for prices when no pricing page is linked; generic software/platform pricing links outside the event's URL scope are ignored.
- **Not found** means the page did not expose supported price/link evidence. It does not mean free or registration closed. A pricing-page link is still provided when found.
- Ticket checks are independent of date verification. Source links are included for prices; cached tickets retained during official-source outages are explicitly stale, with their last-check timestamp. Prices can change, ticket types have eligibility rules, and taxes/fees may be additional. Confirm terms on the registration site.

If an official source becomes unavailable (for example, HTTP 403 or a timeout), previously verified official-only entries from the cache stay visible with a **Stale: source unavailable** label and their original last-verification timestamp. They are not counted as freshly verified. Expired entries age out of the rolling window, fresh records replace cached editions, and explicit official cancellations are not retained. This matters because some organizers block GitHub-hosted runners even when their pages are accessible from a local machine. A source that successfully responds but no longer contains supported evidence is not treated as an outage.

Discovery is **bounded, not exhaustive**. Combining lists improves coverage, but this is not every conference list on the internet, a Google search, or an AI-powered web crawl. Conferences missing from both feeds and without supported metadata on a watched page can be missed. Many official sites publish dates only in JavaScript, images, or unstructured copy. An unsupported watchlist entry does not prove its dates are unannounced. We do not infer a US edition from a previous venue.

Every configured discovery feed and published topic file must load and validate successfully. The current year's confs.tech `data`, `devops`, and `sre` files are required. Missing optional confs.tech topic or future-year files (HTTP 404) are explicitly reported as coverage gaps; other HTTP failures, invalid JSON, invalid records, or an empty developers.events feed fail the refresh without replacing the previous list. A completely empty combined result is also rejected as a safeguard. Official-site failures are nonfatal and explicitly reported; feed entries remain unverified instead of disappearing.

## Extend coverage

- Add recurring official pages to `official` in [sources.json](./sources.json), with topic labels and recognizable name aliases. Conferences still need explicit current dates and a US physical venue to enter the dated table.
- Discovery is an array of source configurations with an explicit `type`: `confs-tech` or `developers-events`. More independent adapters can be added without replacing the existing sources.
- Add confs.tech discovery topics to that source's `topics` array. General-purpose topics only contribute events whose names match the AI/infrastructure rules.
- For an official site without Event JSON-LD, add a small source-specific adapter in [scripts/tracker.mjs](./scripts/tracker.mjs) and a representative fixture test. Prefer explicit date/venue evidence over broad date guessing.
- A paid search API can be added later as another discovery source without changing the Markdown viewing workflow.

## Data attribution

| Source | License / usage |
| --- | --- |
| [confs.tech / tech-conferences/conference-data](https://github.com/tech-conferences/conference-data) | [MIT](https://github.com/tech-conferences/conference-data/blob/main/LICENSE.md); permission notice in [NOTICE](./NOTICE) |
| [developers.events / Developers Conferences Agenda](https://github.com/scraly/developers-conferences-agenda), by Aurelie Vache and contributors | Content: [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), with attribution and noncommercial restrictions |
| Official organizers, including [Meta @Scale](https://atscaleconference.com/) | Linked factual date/venue evidence; not a grant to copy or relicense their site content |

This project filters, normalizes, classifies, merges, and sometimes corrects records using official evidence. Each generated row and cached event retain contributing source URLs. **The combined output is not an MIT-only dataset:** developers.events-derived content remains subject to CC BY-NC 4.0. Keep attribution and license notices if sharing or making this repository public; commercial reuse of that content requires separate permission or excluding it. See [NOTICE](./NOTICE).

Only factual event metadata and short diagnostics are persisted. The generated cache is not a secret and is committed alongside the Markdown; neither contains full copies of official pages. Check organizer pages before registering or booking travel.
