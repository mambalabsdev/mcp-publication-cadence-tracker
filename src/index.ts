#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as { version: string; name: string };

// Distinctive UA so Apify run meta.userAgent marks MCP-originated runs.
const USER_AGENT = `mambalabs-mcp ${pkg.name}@${pkg.version}`;

const APIFY_TOKEN = process.env.APIFY_TOKEN;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: "text"; text: string }>;
};

// Drop undefined values so optional inputs are not sent to the actor.
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// Shared caller. actorPath is the actor's immutable Apify actor ID (a stable key
// that survives Store renames). The /v2/acts/{id} endpoint accepts it directly,
// so a Store rename never breaks these calls.
async function runActor(
  actorPath: string,
  actorLabel: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  if (!APIFY_TOKEN) {
    return { isError: true, content: [{ type: "text", text: "APIFY_TOKEN is not set. Create a token at https://console.apify.com/account/integrations and set it as the APIFY_TOKEN environment variable." }] };
  }

  const url = `https://api.apify.com/v2/acts/${actorPath}/run-sync-get-dataset-items?timeout=300`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APIFY_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(input),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }

    let message: string;
    switch (response.status) {
      case 401:
        message = "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
        break;
      case 402:
        message =
          "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
        break;
      case 408:
        message = `The ${actorLabel} run timed out after 300 seconds. Try a smaller batch, or run the actor on Apify directly for longer jobs.`;
        break;
      default:
        message = `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
    return { isError: true, content: [{ type: "text", text: message }] };
  }

  const items = await response.json();
  return { content: [{ type: "text", text: JSON.stringify(items, null, 2) }] };
}

const server = new McpServer({
  name: "mamba-publication-cadence-tracker",
  version: pkg.version,
});

// Publication Cadence Tracker (immutable actor ID TbLwaUUATdYb6wp4N)
server.registerTool(
  "track_publication_cadence",
  {
    title: "Track Publication Cadence",
    description:
      "Given a company domain, measure how much long-form work that company publishes and whether the rate is rising or falling. Returns post counts for the last 30 days, 90 days and 12 months, a monthly average, and a cadence_trend of accelerating, steady, declining, dormant or unknown, plus the percent change behind it. The trend compares the last 90 days against the prior 275 days, both normalized to posts per month. Also returns the blog URL, the format mix (blog posts, guides, reports, case studies, whitepapers, podcasts, videos, press releases, research), the number of distinct bylines, and how the post list was discovered. This measures EDITORIAL output volume, not product changelogs: a release feed is detected and rejected rather than counted. Publication dates are read from the post pages themselves, because sitemap lastmod was measured to be a modification date that runs later than publication by a median of 151 to 1653 days. When a site's date field turns out to track edits rather than publication, date_source_reliable comes back false and every count is nulled rather than reported wrong, so check that field before quoting a number. Counts are a census when the archive fits the page budget and a scaled even sample otherwise, flagged by counts_are_estimate. Public sitemaps, feeds and pages only. Returns flat Clay-ready JSON. Read-only; requires an APIFY_TOKEN and consumes Apify credits per domain analyzed.",
    annotations: {
      title: "Track Publication Cadence",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      domain: z
        .string()
        .optional()
        .describe("A single company domain, e.g. zapier.com. Provide either domain or domains."),
      domains: z
        .array(z.string())
        .optional()
        .describe("Batch mode: several company domains analyzed in one call. Takes precedence over domain."),
      max_pages_to_date: z
        .number()
        .int()
        .min(20)
        .max(800)
        .optional()
        .describe("How many post pages to fetch per domain for dating. Default 400. Above this cap the counts are estimated from an even sample across the archive and counts_are_estimate is set true. Raise it for a tighter number on a large archive, at the cost of run time."),
      domain_time_budget_ms: z
        .number()
        .int()
        .min(15000)
        .max(240000)
        .optional()
        .describe("Hard wall-clock ceiling per domain, default 75000. When it is nearly spent the crawl stops and the row is returned with partial_result true and reduced confidence rather than timing out."),
      batchSize: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("How many domains to analyze concurrently. Default 2."),
      skipCache: z
        .boolean()
        .optional()
        .describe("Force a fresh crawl and ignore the 3 day result cache."),
      page_concurrency: z
        .number()
        .int()
        .optional()
        .describe("How many pages are fetched concurrently within one domain."),
      max_sitemap_fetches: z
        .number()
        .int()
        .optional()
        .describe("Cap on how many sitemap files are fetched per domain. Lower it to bound run time on sites with deeply nested sitemap indexes."),
      request_timeout_ms: z
        .number()
        .int()
        .optional()
        .describe("Per-HTTP-request timeout in milliseconds."),
    },
  },
  async ({ domain, domains, max_pages_to_date, domain_time_budget_ms, batchSize, skipCache, page_concurrency, max_sitemap_fetches, request_timeout_ms }) => {
    const hasSingle = domain !== undefined && domain !== "";
    const hasBatch = Array.isArray(domains) && domains.length > 0;
    if (!hasSingle && !hasBatch) {
      return {
        isError: true,
        content: [{ type: "text", text: "Provide either domain (a single company domain) or domains (an array)." }],
      };
    }
    return runActor(
      "TbLwaUUATdYb6wp4N",
      "Publication Cadence Tracker",
      compact({
        domain: hasBatch ? undefined : domain,
        domains: hasBatch ? domains : undefined,
        max_pages_to_date,
        domain_time_budget_ms,
        batchSize,
        skipCache,
        page_concurrency,
        max_sitemap_fetches,
        request_timeout_ms,
      }),
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
