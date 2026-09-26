interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * New York Fed Markets Data APIs — markets.newyorkfed.org, keyless JSON, no
 * auth wall. Operation-level and holdings-level Desk data: repo/reverse repo
 * (ON RRP) auction results, securities lending operations, System Open Market
 * Account (SOMA) portfolio holdings, the Desk's reference rates (SOFR, EFFR,
 * OBFR, TGCR, BGCR), and primary dealer survey statistics.
 *
 * DIFFERENT FROM `fred`: FRED (see mcps/fred) carries the daily reference-rate
 * AGGREGATES (e.g. series "SOFR") as a single number per day, sourced from this
 * same Desk release, but nothing else here — no individual repo/RRP operation
 * results, no counterparty participation counts, no SOMA CUSIP-level holdings,
 * no primary dealer survey. This pack is the operation- and security-level
 * data underneath those FRED aggregates: "how much did the Desk accept at
 * today's ON RRP operation and how many counterparties took it", "what CUSIPs
 * does SOMA hold and how much matured this week", not "what was SOFR on date
 * X" (use `fred_get_series` with SOFR/DFF/etc. for that).
 *
 * PROVENANCE / TRAPS, captured live 2026-09-23:
 *
 * - Swagger spec at /static/docs/markets-api.yml (the .html page is a JS SPA
 *   that renders it, so it is useless to fetch directly — fetch the .yml).
 *
 * - THE ONE REAL TRAP: `/api/rp/results/search.json`'s `operationTypes` query
 *   param is a SILENT NO-OP. Querying with `operationTypes=Reverse Repo` still
 *   returns Repo rows mixed in — confirmed live, 21 rows returned for a 9-day
 *   window that should have been ~7 RRP-only rows. `method` and `term` are
 *   UNVERIFIED and are not trusted either. This pack always filters
 *   `operationType`/`term` CLIENT-SIDE after the fetch, never relies on the
 *   query string to do it. The equivalent PATH-based filter on the `latest`
 *   endpoint (`/api/rp/{reverserepo|repo|all}/all/results/latest.json`) DOES
 *   work correctly — verified — so latest-day queries use that instead.
 *
 * - SOMA holdings lag: `/api/soma/asofdates/latest.json` returned 2026-09-16
 *   on 2026-09-23 — a ~1 week publication lag is normal, not a bug.
 *
 * - Agency holding-type path segment `agency debts` contains a literal SPACE
 *   (`/api/soma/agency/get/agency debts/asof/{date}.json`) — this pack accepts
 *   the friendly `agency_debts` and encodes the space for you.
 *
 * - `soma/*​/get/{holdingtype}/asof/{date}` with holdingtype=all returns
 *   EVERY CUSIP at that date (hundreds of rows) — this pack truncates to
 *   `limit` (default 20) and reports `total_count` so a caller isn't silently
 *   handed a clipped-looking small array with no signal that more exists.
 *
 * - Primary dealer stats: keyids are opaque codes (PDPOSMBS-TOT etc.) grouped
 *   into "series break" windows (definitions change over time, so the same
 *   keyid's meaning can shift across windows — /api/pd/list/seriesbreaks.json
 *   is the authoritative window list). This pack resolves "current" as the
 *   window whose `enddate` is "9999-12-31" rather than hardcoding a window id,
 *   so it keeps working across the next series break.
 */


const UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const BASE = 'https://markets.newyorkfed.org/api';

async function nyfedFetch(path: string): Promise<Response> {
  return fetchWithTimeout(`${BASE}${path}`, { headers: { 'User-Agent': UA } }, 'NY Fed Markets Data');
}

async function nyfedGet<T>(path: string): Promise<T> {
  const res = await nyfedFetch(path);
  if (!res.ok) throw await httpError(res, 'NY Fed Markets Data');
  return parseJson<T>(res, 'NY Fed Markets Data');
}

function clamp(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function checkDate(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  if (!DATE_RE.test(s)) throw new Error(`${field} must be YYYY-MM-DD, got "${s}".`);
  return s;
}

// ---------------------------------------------------------------------------
// 1. Repo / Reverse Repo operations
// ---------------------------------------------------------------------------

interface RepoOperation {
  operationId?: string;
  auctionStatus?: string;
  operationDate?: string;
  settlementDate?: string;
  maturityDate?: string;
  operationType?: string; // "Repo" | "Reverse Repo"
  operationMethod?: string;
  settlementType?: string;
  termCalenderDays?: number;
  term?: string; // "Overnight" | "Term"
  releaseTime?: string;
  closeTime?: string;
  note?: string;
  lastUpdated?: string;
  participatingCpty?: number;
  acceptedCpty?: number;
  totalAmtSubmitted?: number;
  totalAmtAccepted?: number;
  details?: Array<{ securityType?: string; amtSubmitted?: number; amtAccepted?: number; percentOfferingRate?: number; percentAwardRate?: number }>;
}

function shapeRepoOp(o: RepoOperation) {
  return {
    operation_id: o.operationId,
    type: o.operationType,
    method: o.operationMethod,
    term: o.term,
    operation_date: o.operationDate,
    settlement_date: o.settlementDate,
    maturity_date: o.maturityDate,
    total_submitted_usd: o.totalAmtSubmitted,
    total_accepted_usd: o.totalAmtAccepted,
    participating_counterparties: o.participatingCpty,
    accepted_counterparties: o.acceptedCpty,
    by_security_type: o.details,
    release_time: o.releaseTime,
    close_time: o.closeTime,
    last_updated: o.lastUpdated,
  };
}

async function nyfedRepoOperations(args: Record<string, unknown>) {
  const operationType = String(args.operation_type ?? 'all').toLowerCase();
  if (!['all', 'repo', 'reverserepo'].includes(operationType)) {
    throw new Error('operation_type must be one of: all, repo, reverserepo.');
  }
  const term = args.term ? String(args.term).toLowerCase() : undefined;
  if (term && !['overnight', 'term'].includes(term)) {
    throw new Error('term must be one of: overnight, term.');
  }
  const startDate = checkDate(args.start_date, 'start_date');
  const endDate = checkDate(args.end_date, 'end_date');
  const limit = clamp(args.limit, 20, 1, 100);

  let ops: RepoOperation[];
  let mode: string;
  if (startDate || endDate) {
    const qs = new URLSearchParams();
    if (startDate) qs.set('startDate', startDate);
    if (endDate) qs.set('endDate', endDate);
    const data = await nyfedGet<{ repo?: { operations?: RepoOperation[] } }>(
      `/rp/results/search.json?${qs.toString()}`,
    );
    ops = data.repo?.operations ?? [];
    // operationTypes/term query params are a confirmed silent no-op upstream —
    // always filter client-side.
    const wantType = operationType === 'repo' ? 'Repo' : operationType === 'reverserepo' ? 'Reverse Repo' : null;
    if (wantType) ops = ops.filter((o) => o.operationType === wantType);
    if (term === 'overnight') ops = ops.filter((o) => o.term === 'Overnight');
    if (term === 'term') ops = ops.filter((o) => o.term && o.term !== 'Overnight');
    mode = 'date_range_search';
  } else {
    const data = await nyfedGet<{ repo?: { operations?: RepoOperation[] } }>(
      `/rp/${operationType}/all/results/latest.json`,
    );
    ops = data.repo?.operations ?? [];
    if (term === 'overnight') ops = ops.filter((o) => o.term === 'Overnight');
    if (term === 'term') ops = ops.filter((o) => o.term && o.term !== 'Overnight');
    mode = 'latest';
  }

  if (ops.length === 0) {
    return {
      found: false,
      reason: mode === 'latest' ? 'no_operation_today' : 'no_operations_in_window',
      hint:
        mode === 'latest'
          ? 'No matching repo/reverse repo operation was conducted today (weekends/holidays and days the Desk skips a leg both look like this). Pass start_date/end_date to search a window instead.'
          : `No operations of type "${operationType}" between ${startDate ?? 'the start of the record'} and ${endDate ?? 'today'}.`,
      operation_type: operationType,
      window: mode === 'date_range_search' ? { start_date: startDate, end_date: endDate } : undefined,
    };
  }

  const total = ops.length;
  const page = ops.slice(0, limit);
  return {
    found: true,
    mode,
    operation_type: operationType,
    window: mode === 'date_range_search' ? { start_date: startDate, end_date: endDate } : undefined,
    total_operations: total,
    returned: page.length,
    operations: page.map(shapeRepoOp),
    source: 'New York Fed Markets Data — Repo and Reverse Repo Operations (markets.newyorkfed.org/api/rp).',
  };
}

// ---------------------------------------------------------------------------
// 2. Securities lending operations
// ---------------------------------------------------------------------------

interface SecLendingOp {
  operationId?: string;
  auctionStatus?: string;
  operationType?: string;
  operationDate?: string;
  settlementDate?: string;
  maturityDate?: string;
  releaseTime?: string;
  closeTime?: string;
  note?: string;
  lastUpdated?: string;
  totalParAmtSubmitted?: number;
  totalParAmtAccepted?: number;
  securities?: unknown[];
}

async function nyfedSeclendingOperations(args: Record<string, unknown>) {
  const operation = String(args.operation ?? 'seclending').toLowerCase();
  if (!['seclending', 'extensions', 'all'].includes(operation)) {
    throw new Error('operation must be one of: seclending, extensions, all.');
  }
  const startDate = checkDate(args.start_date, 'start_date');
  const endDate = checkDate(args.end_date, 'end_date');
  const cusips = args.cusips ? String(args.cusips).trim() : undefined;
  const limit = clamp(args.limit, 20, 1, 100);
  const filtered = Boolean(startDate || endDate || cusips);
  const include = cusips ? 'details' : 'summary';

  let ops: SecLendingOp[];
  let mode: string;
  if (filtered) {
    const qs = new URLSearchParams();
    if (startDate) qs.set('startDate', startDate);
    if (endDate) qs.set('endDate', endDate);
    if (cusips) qs.set('cusips', cusips);
    const data = await nyfedGet<{ seclending?: { operations?: SecLendingOp[] } }>(
      `/seclending/${operation}/results/${include}/search.json?${qs.toString()}`,
    );
    ops = data.seclending?.operations ?? [];
    mode = 'search';
  } else {
    const data = await nyfedGet<{ seclending?: { operations?: SecLendingOp[] } }>(
      `/seclending/${operation}/results/${include}/latest.json`,
    );
    ops = data.seclending?.operations ?? [];
    mode = 'latest';
  }

  if (ops.length === 0) {
    return {
      found: false,
      reason: mode === 'latest' ? 'no_operation_today' : 'no_operations_in_window',
      hint:
        mode === 'latest'
          ? 'No securities lending operation today. Pass start_date/end_date to search a window instead.'
          : 'No securities lending operations matched the given window/cusips filter.',
      operation,
    };
  }

  const total = ops.length;
  const page = ops.slice(0, limit);
  return {
    found: true,
    mode,
    operation,
    include,
    total_operations: total,
    returned: page.length,
    operations: page,
    source: 'New York Fed Markets Data — Securities Lending Operations (markets.newyorkfed.org/api/seclending).',
  };
}

// ---------------------------------------------------------------------------
// 3. SOMA holdings
// ---------------------------------------------------------------------------

let latestSomaDateCache: { date: string; fetchedAt: number } | null = null;
async function getLatestSomaDate(): Promise<string> {
  if (latestSomaDateCache && Date.now() - latestSomaDateCache.fetchedAt < 5 * 60_000) {
    return latestSomaDateCache.date;
  }
  const data = await nyfedGet<{ soma?: { asOfDates?: string[] } }>('/soma/asofdates/latest.json');
  const date = data.soma?.asOfDates?.[0];
  if (!date) throw new Error('upstream_down: NY Fed SOMA asofdates/latest returned no date.');
  latestSomaDateCache = { date, fetchedAt: Date.now() };
  return date;
}

const TREASURY_HOLDING_TYPES = ['all', 'bills', 'notesbonds', 'frn', 'tips'];
const AGENCY_HOLDING_TYPES: Record<string, string> = {
  all: 'all',
  agency_debts: 'agency debts',
  mbs: 'mbs',
  cmbs: 'cmbs',
};

async function nyfedSomaHoldings(args: Record<string, unknown>) {
  const cusip = args.cusip ? String(args.cusip).trim() : undefined;
  const limit = clamp(args.limit, 20, 1, 200);

  if (cusip) {
    const tsy = await nyfedGet<{ soma?: { holdings?: unknown[] } }>(`/soma/tsy/get/cusip/${encodeURIComponent(cusip)}.json`).catch(() => null);
    if (tsy?.soma?.holdings?.length) {
      return {
        found: true,
        holding_class: 'treasury',
        cusip,
        total_observations: tsy.soma.holdings.length,
        returned: Math.min(limit, tsy.soma.holdings.length),
        holdings: tsy.soma.holdings.slice(-limit),
        source: 'New York Fed Markets Data — SOMA Treasury Holdings by CUSIP (markets.newyorkfed.org/api/soma/tsy).',
      };
    }
    const agency = await nyfedGet<{ soma?: { holdings?: unknown[] } }>(`/soma/agency/get/cusip/${encodeURIComponent(cusip)}.json`).catch(() => null);
    if (agency?.soma?.holdings?.length) {
      return {
        found: true,
        holding_class: 'agency',
        cusip,
        total_observations: agency.soma.holdings.length,
        returned: Math.min(limit, agency.soma.holdings.length),
        holdings: agency.soma.holdings.slice(-limit),
        source: 'New York Fed Markets Data — SOMA Agency Holdings by CUSIP (markets.newyorkfed.org/api/soma/agency).',
      };
    }
    return {
      found: false,
      reason: 'cusip_not_held',
      hint: `CUSIP "${cusip}" was not found in either SOMA Treasury or Agency holdings (checked both).`,
      cusip,
    };
  }

  const view = String(args.view ?? 'summary').toLowerCase();

  if (view === 'summary') {
    const data = await nyfedGet<{ soma?: { summary?: Array<Record<string, unknown>> } }>('/soma/summary.json');
    const rows = data.soma?.summary ?? [];
    const asOfDate = checkDate(args.as_of_date, 'as_of_date');
    if (asOfDate) {
      const row = rows.find((r) => r.asOfDate === asOfDate);
      if (!row) {
        return {
          found: false,
          reason: 'no_summary_for_date',
          hint: `No SOMA summary row for ${asOfDate}. Summaries are published weekly — try a nearby Wednesday, or omit as_of_date for the most recent rows.`,
          as_of_date: asOfDate,
        };
      }
      return { found: true, view: 'summary', as_of_date: asOfDate, row, source: 'New York Fed Markets Data — SOMA Holdings Summary (markets.newyorkfed.org/api/soma/summary).' };
    }
    const page = rows.slice(-limit);
    return {
      found: true,
      view: 'summary',
      total_observations: rows.length,
      returned: page.length,
      note: 'Total SOMA holdings by security-type bucket (mbs, notesbonds, bills, agencies, tips, ...), one row per publication date. Weekly cadence.',
      rows: page,
      source: 'New York Fed Markets Data — SOMA Holdings Summary (markets.newyorkfed.org/api/soma/summary).',
    };
  }

  const asOfDate = checkDate(args.as_of_date, 'as_of_date') ?? (await getLatestSomaDate());

  if (view === 'treasury') {
    const holdingType = String(args.holding_type ?? 'all').toLowerCase();
    if (!TREASURY_HOLDING_TYPES.includes(holdingType)) {
      throw new Error(`holding_type for view=treasury must be one of: ${TREASURY_HOLDING_TYPES.join(', ')}.`);
    }
    const data = await nyfedGet<{ soma?: { holdings?: unknown[] } }>(
      `/soma/tsy/get/${holdingType}/asof/${asOfDate}.json`,
    );
    const holdings = data.soma?.holdings ?? [];
    return {
      found: holdings.length > 0,
      view: 'treasury',
      holding_type: holdingType,
      as_of_date: asOfDate,
      total_holdings: holdings.length,
      returned: Math.min(limit, holdings.length),
      holdings: holdings.slice(0, limit),
      source: 'New York Fed Markets Data — SOMA Treasury Holdings (markets.newyorkfed.org/api/soma/tsy).',
    };
  }

  if (view === 'agency') {
    const rawType = String(args.holding_type ?? 'all').toLowerCase();
    const holdingType = AGENCY_HOLDING_TYPES[rawType];
    if (!holdingType) {
      throw new Error(`holding_type for view=agency must be one of: ${Object.keys(AGENCY_HOLDING_TYPES).join(', ')}.`);
    }
    const data = await nyfedGet<{ soma?: { holdings?: unknown[] } }>(
      `/soma/agency/get/${encodeURIComponent(holdingType)}/asof/${asOfDate}.json`,
    );
    const holdings = data.soma?.holdings ?? [];
    return {
      found: holdings.length > 0,
      view: 'agency',
      holding_type: rawType,
      as_of_date: asOfDate,
      total_holdings: holdings.length,
      returned: Math.min(limit, holdings.length),
      holdings: holdings.slice(0, limit),
      source: 'New York Fed Markets Data — SOMA Agency Holdings (markets.newyorkfed.org/api/soma/agency).',
    };
  }

  throw new Error('view must be one of: summary, treasury, agency.');
}

// ---------------------------------------------------------------------------
// 4. Reference rates
// ---------------------------------------------------------------------------

const SECURED = new Set(['tgcr', 'bgcr', 'sofr', 'sofrai']);
const UNSECURED = new Set(['effr', 'obfr']);

async function nyfedReferenceRates(args: Record<string, unknown>) {
  const rateType = String(args.rate_type ?? 'all').toLowerCase();
  const number = clamp(args.number, 1, 1, 100);

  if (rateType === 'all') {
    const data = await nyfedGet<{ refRates?: unknown[] }>('/rates/all/latest.json');
    const rows = data.refRates ?? [];
    return {
      found: rows.length > 0,
      rate_type: 'all',
      rows,
      note: 'Latest observation for each of SOFR, SOFRAI (30/90/180-day averages + index), EFFR, OBFR, TGCR, BGCR. Rates are published the business day AFTER the effective date (an EFFR/OBFR/TGCR/BGCR dated "today" was not yet observed — that is normal, not a lag).',
      source: 'New York Fed Markets Data — Reference Rates (markets.newyorkfed.org/api/rates).',
    };
  }

  if (!SECURED.has(rateType) && !UNSECURED.has(rateType)) {
    throw new Error(
      `rate_type must be one of: all, sofr, sofrai, tgcr, bgcr (secured), effr, obfr (unsecured). Got "${rateType}".`,
    );
  }
  const bucket = SECURED.has(rateType) ? 'secured' : 'unsecured';
  const data = await nyfedGet<{ refRates?: unknown[] }>(`/rates/${bucket}/${rateType}/last/${number}.json`);
  const rows = data.refRates ?? [];
  return {
    found: rows.length > 0,
    rate_type: rateType,
    bucket,
    requested: number,
    returned: rows.length,
    rows,
    source: `New York Fed Markets Data — Reference Rates, ${bucket} (markets.newyorkfed.org/api/rates/${bucket}).`,
  };
}

// ---------------------------------------------------------------------------
// 5. Primary dealer statistics
// ---------------------------------------------------------------------------

interface SeriesBreak {
  label?: string;
  seriesbreak?: string;
  startdate?: string;
  enddate?: string;
}

let currentSeriesBreakCache: { seriesbreak: string; fetchedAt: number } | null = null;
async function getCurrentSeriesBreak(): Promise<string> {
  if (currentSeriesBreakCache && Date.now() - currentSeriesBreakCache.fetchedAt < 60 * 60_000) {
    return currentSeriesBreakCache.seriesbreak;
  }
  const data = await nyfedGet<{ pd?: { seriesbreaks?: SeriesBreak[] } }>('/pd/list/seriesbreaks.json');
  const breaks = data.pd?.seriesbreaks ?? [];
  const current = breaks.find((b) => b.enddate === '9999-12-31') ?? breaks[breaks.length - 1];
  if (!current?.seriesbreak) throw new Error('upstream_down: could not resolve the current Primary Dealer series-break window.');
  currentSeriesBreakCache = { seriesbreak: current.seriesbreak, fetchedAt: Date.now() };
  return current.seriesbreak;
}

async function nyfedPrimaryDealerStats(args: Record<string, unknown>) {
  const mode = String(args.mode ?? 'list_series').toLowerCase();
  const keidFilter = args.keyid_filter ? String(args.keyid_filter).trim().toLowerCase() : undefined;
  const limit = clamp(args.limit, 50, 1, 200);

  if (mode === 'list_series') {
    const data = await nyfedGet<{ pd?: { timeseries?: Array<{ seriesbreak?: string; keyid?: string; description?: string }> } }>(
      '/pd/list/timeseries.json',
    );
    let rows = data.pd?.timeseries ?? [];
    if (keidFilter) {
      rows = rows.filter(
        (r) => r.keyid?.toLowerCase().includes(keidFilter) || r.description?.toLowerCase().includes(keidFilter),
      );
    }
    const total = rows.length;
    return {
      found: total > 0,
      mode: 'list_series',
      keyid_filter: keidFilter,
      total_matching: total,
      returned: Math.min(limit, total),
      series: rows.slice(0, limit),
      note: 'Definitions of the opaque keyid codes used by mode=latest. Pass a substring in keyid_filter (e.g. "treasury", "mbs", "agency") to narrow.',
      source: 'New York Fed Markets Data — Primary Dealer Statistics, series definitions (markets.newyorkfed.org/api/pd).',
    };
  }

  if (mode === 'latest') {
    const seriesbreak = args.seriesbreak ? String(args.seriesbreak).trim() : await getCurrentSeriesBreak();
    const data = await nyfedGet<{ pd?: { timeseries?: Array<{ asofdate?: string; keyid?: string; value?: string }> } }>(
      `/pd/latest/${encodeURIComponent(seriesbreak)}.json`,
    );
    let rows = data.pd?.timeseries ?? [];
    if (keidFilter) rows = rows.filter((r) => r.keyid?.toLowerCase().includes(keidFilter));
    const total = rows.length;
    if (total === 0) {
      return {
        found: false,
        reason: 'no_matching_keyids',
        hint: keidFilter
          ? `No keyid in series-break window "${seriesbreak}" matched "${keidFilter}". Call mode=list_series to browse the full keyid catalog.`
          : `Series-break window "${seriesbreak}" returned no rows — check it against /pd/list/seriesbreaks.json.`,
        seriesbreak,
      };
    }
    return {
      found: true,
      mode: 'latest',
      seriesbreak,
      as_of_date: rows[0]?.asofdate,
      keyid_filter: keidFilter,
      total_matching: total,
      returned: Math.min(limit, total),
      values: rows.slice(0, limit),
      note: 'Latest weekly FR 2004 primary dealer survey values for the matching keyids ("*" means the observation is suppressed/not reported that week). Use mode=list_series to look up what a keyid means.',
      source: 'New York Fed Markets Data — Primary Dealer Statistics (markets.newyorkfed.org/api/pd).',
    };
  }

  throw new Error('mode must be one of: list_series, latest.');
}

// ---------------------------------------------------------------------------

const tools: McpToolExport['tools'] = [
  {
    name: 'nyfed_repo_operations',
    description:
      "NY Fed Desk repo and reverse repo (ON RRP) operation RESULTS — the actual auctions the Desk ran, not a daily rate aggregate. Each operation: total submitted/accepted USD, counterparty counts, award rate(s), breakdown by security type (Treasury/Agency/MBS/SRF). No start_date/end_date -> today's operation(s) only (empty on weekends/holidays). With start_date/end_date -> a date-range search. Use for \"today's ON RRP usage\", \"reverse repo take-up this week vs last\", \"who's using the SRF\". Different from fred_get_series('RRPONTSYD') which only has the daily accepted total, no per-operation detail.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation_type: { type: 'string', enum: ['all', 'repo', 'reverserepo'], description: 'repo = Desk lends cash (RP); reverserepo = Desk borrows cash (ON RRP). Default all.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive. Triggers a date-range search instead of "latest".' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        term: { type: 'string', enum: ['overnight', 'term'], description: 'Filter to overnight-only or term operations.' },
        limit: { type: 'number', description: 'Max operations to return, newest first. Default 20, max 100.' },
      },
    },
  },
  {
    name: 'nyfed_seclending_operations',
    description:
      'NY Fed Desk securities lending operation results — how much of the SOMA portfolio was lent out today (or in a date range), by operation (seclending = the daily program, extensions = extended-term lending). Returns total par amount submitted/accepted and, when cusips is given, per-security detail. Use for "how active is securities lending today", "was CUSIP X lent out this week".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: { type: 'string', enum: ['seclending', 'extensions', 'all'], description: 'Default seclending.' },
        start_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        cusips: { type: 'string', description: 'Comma-separated CUSIP(s) to filter to (partial match).' },
        limit: { type: 'number', description: 'Default 20, max 100.' },
      },
    },
  },
  {
    name: 'nyfed_soma_holdings',
    description:
      "System Open Market Account (SOMA) portfolio — the Fed's own securities holdings from QE/reinvestment. view=summary (default) gives total by asset bucket (bills, notesbonds, mbs, agencies, tips) over time — the series to read for \"SOMA runoff this month\". view=treasury/agency with as_of_date gives the full CUSIP-level holdings snapshot for that date (holding_type narrows to bills/notesbonds/frn/tips for treasury, or agency_debts/mbs/cmbs for agency). Pass cusip alone to look up one security's full holdings history regardless of view. Publishes on a ~1-week lag (as_of_date defaults to the latest available, not today).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        view: { type: 'string', enum: ['summary', 'treasury', 'agency'], description: 'Default summary.' },
        holding_type: { type: 'string', description: 'For view=treasury: all|bills|notesbonds|frn|tips. For view=agency: all|agency_debts|mbs|cmbs.' },
        as_of_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to the latest published SOMA as-of date.' },
        cusip: { type: 'string', description: "A single security's CUSIP — overrides view and searches both Treasury and Agency holdings." },
        limit: { type: 'number', description: 'Max rows to return. Default 20, max 200.' },
      },
    },
  },
  {
    name: 'nyfed_reference_rates',
    description:
      "The Desk's own reference-rate publications: SOFR, SOFRAI (30/90/180-day compounded averages + index), EFFR (effective fed funds), OBFR (overnight bank funding), TGCR/BGCR (tri-party general collateral rates). rate_type=all (default) returns the latest value of every rate in one call; a specific rate_type with number>1 returns that rate's recent history including percentile bands and traded volume — detail fred_get_series('SOFR') etc. does not carry (FRED has only the single daily value, no percentiles/volume).",
    inputSchema: {
      type: 'object' as const,
      properties: {
        rate_type: { type: 'string', enum: ['all', 'sofr', 'sofrai', 'tgcr', 'bgcr', 'effr', 'obfr'], description: 'Default all.' },
        number: { type: 'number', description: 'History length when rate_type is not "all". Default 1 (latest only), max 100.' },
      },
    },
  },
  {
    name: 'nyfed_primary_dealer_stats',
    description:
      'FR 2004 weekly primary dealer positioning/transaction survey (aggregate across all primary dealers). mode=list_series (default) browses the keyid catalog — pass keyid_filter (e.g. "treasury", "mbs", "agency") to find the codes you want. mode=latest returns the most recent weekly values for matching keyids. Data is reported for the current "series break" window automatically (definitions can change across windows; pass seriesbreak explicitly to pin one — see mode=list_series output for window ids).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['list_series', 'latest'], description: 'Default list_series.' },
        keyid_filter: { type: 'string', description: 'Substring to match against keyid or its description.' },
        seriesbreak: { type: 'string', description: 'Pin a specific series-break window id (e.g. "SBN2024"). Defaults to the current window.' },
        limit: { type: 'number', description: 'Default 50, max 200.' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'nyfed_repo_operations':
      return nyfedRepoOperations(args);
    case 'nyfed_seclending_operations':
      return nyfedSeclendingOperations(args);
    case 'nyfed_soma_holdings':
      return nyfedSomaHoldings(args);
    case 'nyfed_reference_rates':
      return nyfedReferenceRates(args);
    case 'nyfed_primary_dealer_stats':
      return nyfedPrimaryDealerStats(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
