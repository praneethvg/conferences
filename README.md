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

The workflow tests the tracker, collects events, and commits only the generated Markdown. Its built-in `GITHUB_TOKEN` has write access in that job; no personal access token or search secret is needed. GitHub-hosted runner usage remains subject to your account's private-repository Actions allowance. Organization policies can restrict Actions or token write access.

Schedules run only from the default branch and may be delayed. If you later make the repository public, GitHub can disable scheduled workflows after 60 days of repository inactivity; check Actions if updates stop. Failed refreshes leave the previous successful list intact. **Always check the list's refresh timestamp** and workflow status rather than assuming the list is current.

## Refresh locally

Requires Node.js 22 or newer:

```sh
npm test
npm run refresh
```

There is nothing to install. The command atomically replaces [CONFERENCES.md](./CONFERENCES.md) only after collection succeeds. It does not commit or push local changes.

For a reproducible date window:

```sh
npm run refresh -- --as-of 2026-10-17
```

The window starts on the selected UTC calendar day and ends just before the same calendar date next year. Ongoing conferences are included; events beginning at the upper boundary are excluded. Leap-day anniversaries clamp to February 28. No previous-year dates are automatically shifted into a future year.

## How discovery and verification work

1. Read selected current- and next-year topic files directly from the public [confs.tech dataset](https://github.com/tech-conferences/conference-data). New events added to these files are found on subsequent runs. No GitHub API quota or credentials are involved.
2. Keep US physical/hybrid events whose dates overlap the window. Classify by conference name and relevant feed topics, then deduplicate.
3. Fetch each event's official link and the recurring conferences in [sources.json](./sources.json). Reuse requests to the same URL and limit concurrency and retries.
4. Verify matching Schema.org JSON-LD Event records, including dates and a US physical venue. Official corrections take precedence when the name and edition match unambiguously.
5. Use narrowly scoped official-page adapters where needed: GTC, AWS re:Invent, Google Cloud Next, AI Engineer, ODSC, CVPR, the NeurIPS Atlanta satellite, and the USENIX systems-conference table. Each requires explicit edition, date, and venue evidence. These deliberately stop matching when a site changes instead of guessing.
6. Generate a chronological table, topic counts, recurring-event watchlist, source attribution, and detailed refresh health.

**Feed only** means community-reported dates, not official confirmation. Fetching a page successfully does not verify its dates. Unsupported, malformed, ambiguous, or blocked official pages remain visible in the health section. Feed-only conflicts are flagged rather than hidden.

Discovery is **bounded, not exhaustive**. This is not a Google search or an AI-powered web crawl. Conferences missing from the selected feed and without supported metadata on a watched page can be missed. Many official sites publish dates only in JavaScript, images, or unstructured copy. An unsupported watchlist entry does not prove its dates are unannounced. We do not infer a US edition from a previous venue.

Every published discovery file must load and validate successfully. The current year's `data`, `devops`, and `sre` files are required. Missing optional topic or future-year files (HTTP 404) are explicitly reported as coverage gaps; other HTTP failures, invalid JSON, or invalid required records fail the refresh without replacing the previous list. A completely empty result is also rejected as a safeguard. Official-site failures are nonfatal and explicitly reported; feed entries remain unverified instead of disappearing.

## Extend coverage

- Add recurring official pages to `official` in [sources.json](./sources.json), with topic labels and recognizable name aliases. Conferences still need explicit current dates and a US physical venue to enter the dated table.
- Add discovery topics to `discovery.topics`. General-purpose topics only contribute events whose names match the AI/infrastructure rules.
- For an official site without Event JSON-LD, add a small source-specific adapter in [scripts/tracker.mjs](./scripts/tracker.mjs) and a representative fixture test. Prefer explicit date/venue evidence over broad date guessing.
- A paid search API can be added later as another discovery source without changing the Markdown viewing workflow.

## Data attribution

Conference metadata is discovered from **confs.tech / tech-conferences/conference-data**, a community-maintained dataset under its [MIT license](https://github.com/tech-conferences/conference-data/blob/main/LICENSE.md). This project filters, normalizes, classifies, combines duplicates, and checks some records against official sources. The upstream permission notice is reproduced in [NOTICE](./NOTICE).

Only factual event metadata and short diagnostics are persisted. Full official pages are not copied into the repository. Check organizer pages before registering or booking travel.
