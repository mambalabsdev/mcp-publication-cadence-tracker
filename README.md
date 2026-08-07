# Publication Cadence Tracker MCP Server

[![npm](https://img.shields.io/npm/v/@mambalabsdev/mcp-publication-cadence-tracker)](https://www.npmjs.com/package/@mambalabsdev/mcp-publication-cadence-tracker)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

MCP server for the Mamba Labs [Publication Cadence Tracker](https://apify.com/mambalabs/publication-cadence-tracker) actor on Apify.

Give it a company domain. It tells your agent how much long-form work that company publishes per month, and whether that rate is rising or falling.

## Tool

`track_publication_cadence`

Returns a flat row per domain: `posts_last_30d`, `posts_last_90d`, `posts_last_12m`, `avg_posts_per_month`, `cadence_trend` (`accelerating`, `steady`, `declining`, `dormant`, `unknown`), `trend_pct_change`, `most_recent_post_date`, `days_since_last_post`, `blog_url`, `formats_detected[]`, `distinct_authors_count`, `discovery_method`, `confidence`, and an `evidence[]` array of quotable strings.

## Why the trend and not the count

Four pieces a month is unremarkable. Going from four to twelve in six months is a content operation outgrowing its staff. The comparison is stated rather than implied: the last 90 days against the prior 275 days, both normalized to posts per month, with `accelerating` and `declining` set at 25 percent either way.

This is editorial output volume, not changelog monitoring. A release feed is detected and rejected rather than counted as published work.

## The number it refuses to give you

Publication dates come from the post pages, never from sitemap `lastmod`. Across 100 measured URL pairs, `lastmod` tracked the page's own `dateModified` and ran later than `datePublished` by a median of 151 to 1653 days on four of six sites. A cadence built on it would report a company that refreshed 200 old posts as a company that published 200 posts.

A page field can fail the same way, so it is checked against its own distribution and against the site's feed. When it fails, `date_source_reliable` comes back false and **every count is nulled**. Check that field before quoting a number.

Measured on nine live domains: a rate recovered on 5 of 6 publishers, 3 of 3 controls correctly returning nothing. The one miss is the guard refusing a site whose date field tracks edits.

## `track_publication_cadence`

| Input | Type | Notes |
|---|---|---|
| `domain` | string | One company domain. |
| `domains` | string[] | Batch. Takes precedence over `domain`. |
| `max_pages_to_date` | integer | Post pages fetched per domain, default 400. Above this the counts are estimated from an even sample. |
| `domain_time_budget_ms` | integer | Hard per-domain wall-clock ceiling, default 75000. |
| `batchSize` | integer | Concurrent domains, default 2. |
| `skipCache` | boolean | Ignore the 3 day result cache. |

## What it actually measures

Not whether a company has a blog. How much it published, when, and whether the rate moved.

Finding the blog is most of the work, and it is where a naive version fails. The blog often lives on a different host from the apex and the apex sitemap never mentions it (`blog.hubspot.com`). A homepage sometimes advertises only a changelog feed while linking to the real blog repeatedly (`about.gitlab.com`). Paths are often locale prefixed, so `/en-uk/` and `/bg-bg/` fragment the archive into forty pieces. All three are handled, and `blog_url` reports a locale-prefixed section as `https://example.com/*/knowledge/`.

**Three fields to read before you trust a number.** `date_source_reliable` false means the site's date field tracks edits rather than publication and every count has been nulled. `counts_are_estimate` true means the archive was larger than the page budget and the counts come from a scaled even sample, so two runs can differ by a few posts. `partial_result` true means the wall-clock budget stopped the crawl and the numbers are lower bounds.

## Setup

```json
{
  "mcpServers": {
    "mamba-publication-cadence-tracker": {
      "command": "npx",
      "args": ["-y", "@mambalabsdev/mcp-publication-cadence-tracker"],
      "env": { "APIFY_TOKEN": "your-apify-token" }
    }
  }
}
```

Get a token at [console.apify.com/account/integrations](https://console.apify.com/account/integrations). Read-only; consumes Apify credits per domain analyzed.

## Also available

This tool is also exposed by the [GTM Suite](https://www.npmjs.com/package/@mambalabsdev/mcp-gtm-suite) umbrella server, alongside the rest of the Mamba Labs GTM actors, if you would rather run one server than many.

Built by [Mamba Labs](https://apify.com/mambalabs).
