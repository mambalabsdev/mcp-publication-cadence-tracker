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

// START AND POLL, NOT RUN-SYNC. Apify's synchronous endpoint carries a platform
// ceiling of 300 seconds on the HTTP wait and answers 408 past it while the run
// keeps going and keeps billing. Starting the run, polling it to a terminal
// status, and then reading the dataset waits as long as the actor needs.
//
// How long the actor run itself may take, in seconds: long enough for a large
// batch, short enough that a hung run cannot bill indefinitely.
const ACTOR_RUN_TIMEOUT_SECS = 1800;
// How long this wrapper waits: the run's own timeout plus two minutes, so the
// run's TIMED-OUT status is what the caller sees.
const WRAPPER_WAIT_MS = (ACTOR_RUN_TIMEOUT_SECS + 120) * 1000;
const POLL_INTERVAL_MS = Number(process.env.MAMBA_POLL_INTERVAL_MS ?? 3000);
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "TIMED-OUT", "ABORTED", "ABORTING"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const headers = {
    Authorization: `Bearer ${APIFY_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  const httpError = async (response: Response): Promise<string> => {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = ` ${body.error.message}`;
    } catch {
      detail = "";
    }
    switch (response.status) {
      case 400:
        return `The ${actorLabel} run was rejected as invalid input.${detail}`;
      case 401:
        return "Invalid Apify token. Check your APIFY_TOKEN environment variable.";
      case 402:
        return "Insufficient Apify credits. Check your account balance at https://console.apify.com/billing";
      default:
        return `Apify request to ${actorLabel} failed with status ${response.status}.${detail}`;
    }
  };

  // 1. Start the run.
  let started: Response;
  try {
    started = await fetch(
      `https://api.apify.com/v2/acts/${actorPath}/runs?timeout=${ACTOR_RUN_TIMEOUT_SECS}`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not reach the Apify API: ${message}` }] };
  }
  if (!started.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(started) }] };
  }

  let run: { id?: string; status?: string; defaultDatasetId?: string };
  try {
    run = ((await started.json()) as { data?: typeof run }).data ?? {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned a response that could not be parsed: ${message}` }] };
  }
  const runId = run.id;
  if (!runId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run start returned no run id, so there is nothing to wait for.` }] };
  }

  // 2. Poll to a terminal status.
  const deadline = Date.now() + WRAPPER_WAIT_MS;
  let status = run.status ?? "READY";
  let datasetId = run.defaultDatasetId;
  while (!TERMINAL.has(status)) {
    if (Date.now() >= deadline) {
      return {
        isError: true,
        content: [{ type: "text", text: `The ${actorLabel} run ${runId} was still ${status} after ${Math.round(WRAPPER_WAIT_MS / 1000)} seconds and this call stopped waiting. The run itself is still on Apify: read it at https://console.apify.com/actors/runs/${runId}` }],
      };
    }
    await sleep(POLL_INTERVAL_MS);
    let poll: Response;
    try {
      poll = await fetch(`https://api.apify.com/v2/actor-runs/${runId}`, { headers });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { isError: true, content: [{ type: "text", text: `Lost contact with the Apify API while waiting for ${actorLabel} run ${runId}: ${message}` }] };
    }
    if (!poll.ok) {
      return { isError: true, content: [{ type: "text", text: await httpError(poll) }] };
    }
    const body = (await poll.json()) as { data?: { status?: string; defaultDatasetId?: string } };
    status = body.data?.status ?? status;
    datasetId = body.data?.defaultDatasetId ?? datasetId;
  }

  // 3. A run that did not succeed is a failure the caller must see, never an
  // empty success.
  if (status !== "SUCCEEDED") {
    return {
      isError: true,
      content: [{ type: "text", text: `The ${actorLabel} run did not succeed (run ID: ${runId}, status: ${status}).` }],
    };
  }
  if (!datasetId) {
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run ${runId} succeeded but reported no dataset, so there is nothing to return.` }] };
  }

  // 4. Read the dataset. Pass actor output through unchanged: the wrapper never
  // reinterprets a status field.
  let ds: Response;
  try {
    ds = await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?format=json`, { headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `Could not read the ${actorLabel} dataset: ${message}` }] };
  }
  if (!ds.ok) {
    return { isError: true, content: [{ type: "text", text: await httpError(ds) }] };
  }

  let items: unknown;
  try {
    items = await ds.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run returned a response that could not be parsed: ${message}` }] };
  }

  if (!Array.isArray(items)) {
    const asObj = items as { error?: { type?: string; message?: string } };
    const detail = asObj?.error?.message ? `${asObj.error.message}` : JSON.stringify(items);
    return { isError: true, content: [{ type: "text", text: `The ${actorLabel} run did not return a dataset. ${detail}` }] };
  }

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
        .describe("Batch mode: several company domains analyzed in one call. Takes precedence over domain. Each domain can take up to domain_time_budget_ms (default 75 seconds), and batchSize domains run at once, so a list of 20 at the defaults takes about 12 minutes; this call waits for the whole run."),
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
        .min(1)
        .max(16)
        .optional()
        .describe("How many pages are fetched concurrently within one domain, 1 to 16, default 8."),
      max_sitemap_fetches: z
        .number()
        .int()
        .min(4)
        .max(40)
        .optional()
        .describe("Cap on how many sitemap files are fetched per domain, 4 to 40, default 18. Lower it to bound run time on sites with deeply nested sitemap indexes."),
      request_timeout_ms: z
        .number()
        .int()
        .min(3000)
        .max(20000)
        .optional()
        .describe("Per HTTP request timeout in milliseconds, 3000 to 20000, default 9000."),
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
