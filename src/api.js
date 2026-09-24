/**
 * The 3DPACK.ING API, and the shaping that makes its answer fit in a model's context.
 *
 * Kept apart from the MCP plumbing in index.js so it can be exercised without
 * standing up a server -- see smoke.js, which is the only way to find out whether
 * the live endpoint still answers the shape this file assumes.
 */

/**
 * Overridable so this can be pointed at a staging deployment, a self-hosted
 * instance, or a stub -- which is also the only way to exercise the success path
 * without spending a real calculation against someone's monthly allowance.
 */
export const ENDPOINT =
  process.env.THREEDPACKING_ENDPOINT?.trim() || "https://3dpack.ing/api/ai/calculate";
/**
 * The pricing section, not `/app`. When an assistant relays a plan limit it is
 * quoting this URL to someone who has just been told they cannot do the thing they
 * asked for -- landing them on the planner makes them hunt for the plans, and the
 * moment passes.
 */
export const UPGRADE_URL = "https://3dpack.ing/#pricing";
export const SIGNUP_URL = "https://3dpack.ing/login";

/** What the docs hand out so a call works before an account does. */
export const DEMO_CREDENTIALS = { apiKey: "test", username: "test" };

/** The prompt is truncated server-side at this length; do it here so we can say so. */
const MAX_PROMPT = 4000;

/**
 * Credentials from the environment, falling back to the published demo pair.
 *
 * The fallback is deliberate. An MCP server that cannot answer until someone has
 * registered, found a key and edited a config file is one that gets uninstalled
 * during setup -- the first call has to work. `isDemo` is carried out so the caller
 * can say, once and not on every turn, that this is a shared demo account on the
 * free plan.
 */
export function credentialsFromEnv(env = process.env) {
  const apiKey = env.THREEDPACKING_API_KEY?.trim();
  const username = env.THREEDPACKING_USERNAME?.trim();

  if (apiKey && username) return { apiKey, username, isDemo: false };

  // A key without a username is a 400 from the API. Better to fall back to the
  // demo pair, which works, than to send half a credential and fail obscurely.
  return { ...DEMO_CREDENTIALS, isDemo: true };
}

/**
 * Credentials for a hosted caller, from the query string or headers.
 *
 * The environment is one user for the life of a process, which is right for stdio and
 * wrong for an endpoint serving everybody. Three shapes are accepted because three
 * shapes are what clients send:
 *
 *   ?config=<base64 json>            Smithery's, and the reason this is not just query params
 *   ?apiKey=…&username=…             plain query, what a person testing with curl writes
 *   X-3dpacking-Api-Key / -Username  headers, for anyone who would rather not put a key in a URL
 *
 * The key is also read from `X-API-Key` and `Authorization: Bearer …`. Claude's
 * custom-connector dialog only sends header names Anthropic has approved, and
 * `X-3dpacking-Api-Key` is not one of them -- saving it is refused outright. Those two
 * are on the list. The username has no approved header to ride in, and it is not a
 * secret, so a connector puts it in the URL (`?username=…`) and the key in a header.
 *
 * A signed-in account arrives as `Authorization: Bearer 3dp.<username>.<key>` -- the
 * access token 3dpack.ing's OAuth endpoint issues, which is an ordinary API key
 * created for that account at sign-in, with its username in front. So the key checks,
 * the credit accounting and revocation are the ones every other key already has.
 *
 * Same fallback rule as the environment: half a credential becomes the demo pair
 * rather than an obscure 400. No credential at all is different: it is marked
 * `anonymous`, and the HTTP transport answers it with a 401 that sends the client to
 * sign in -- which is how Claude and ChatGPT know to show a login.
 */
export function credentialsFromConfig(searchParams, headers = {}) {
  const account = accountToken(bearerToken(headers.authorization));
  if (account) return { ...account, isDemo: false };

  let fromConfigParam = {};
  const encoded = searchParams?.get?.("config");

  if (encoded) {
    try {
      // base64url as well as base64: Smithery sends the former and atob-style decoders
      // reject it, which fails as "no credentials" rather than as anything diagnosable.
      const json = Buffer.from(encoded, "base64").toString("utf8");
      const parsed = JSON.parse(json);
      if (parsed && typeof parsed === "object") fromConfigParam = parsed;
    } catch {
      // A malformed config is not worth failing the session over -- it falls through
      // to the demo pair, which is the same place no config at all lands.
    }
  }

  const pick = (configKey, queryKey, headerKey) =>
    (fromConfigParam[configKey] ?? searchParams?.get?.(queryKey) ?? headers[headerKey])
      ?.toString()
      .trim() || undefined;

  const apiKey =
    pick("apiKey", "apiKey", "x-3dpacking-api-key") ??
    (headers["x-api-key"]?.toString().trim() || undefined) ??
    bearerToken(headers.authorization);
  const username = pick("username", "username", "x-3dpacking-username");

  if (apiKey && username) return { apiKey, username, isDemo: false };

  return { ...DEMO_CREDENTIALS, isDemo: true, anonymous: !apiKey && !username };
}

/**
 * An access token from 3dpack.ing's OAuth endpoint: `3dp.<base64url username>.<key>`.
 * Null for anything else, including a plain API key sent as a bearer token.
 */
export function accountToken(token) {
  const match = /^3dp\.([A-Za-z0-9_-]+)\.(\S+)$/.exec(token ?? "");
  if (!match) return null;
  const username = Buffer.from(match[1], "base64url").toString("utf8").trim();
  return username ? { apiKey: match[2], username } : null;
}

/**
 * The token from an `Authorization` header, with or without the `Bearer` scheme.
 *
 * Claude sends the value exactly as typed and adds no scheme, so a bare key is as
 * likely to arrive as a proper `Bearer <key>`. Any other scheme -- Basic, say -- is
 * not a key and is ignored rather than guessed at.
 */
function bearerToken(header) {
  const value = header?.toString().trim();
  if (!value) return undefined;

  const match = value.match(/^Bearer\s+(\S+)$/i);
  if (match) return match[1];

  return /\s/.test(value) ? undefined : value;
}

/**
 * Why a call failed, in terms the caller can act on.
 *
 * `plan_limit` is the one that matters. The API reports a plan limitation as HTTP
 * 500 with `Calculation failed: [NotSubscribed "..."]` in the body -- the same
 * status it uses for a solver crash. Left alone, an assistant reads that as "the
 * service is broken" and tells the user to try later, when what actually happened
 * is that they asked for a Pro feature. Sorting it here is the difference between a
 * dead end and an offer.
 */
export function classifyFailure(status, body) {
  const message = typeof body?.error === "string" ? body.error : "";

  // 402 is how the API says "this needs a plan" as of 2026-07-29. Before that the
  // same refusal arrived as a 500 with the server's own union printed into the
  // string -- `Calculation failed: [NotSubscribed "…is part of Pro."]` -- which is
  // what the pattern below matches.
  //
  // Both are kept. The status is the real signal and the pattern is the fallback,
  // because a deployment older than that change still answers the old way and this
  // package has no way to know which it is talking to. The old form also arrived as
  // invalid JSON, so `body` may well be null for it -- hence the status check first.
  if (status === 402) {
    return { kind: "plan_limit", detail: message };
  }

  if (/NotSubscribed/i.test(message)) {
    const detail = message.match(/NotSubscribed\s+"([^"]*)"/)?.[1] ?? message;
    return { kind: "plan_limit", detail };
  }

  if (status === 400) return { kind: "bad_request", detail: message };
  if (status === 401) return { kind: "no_credentials", detail: message };
  if (status === 403) return { kind: "rejected_or_out_of_credit", detail: message };

  return { kind: "server_error", detail: message || `HTTP ${status}` };
}

/**
 * One container, reduced to what a person asking "will it fit" needs.
 *
 * `emptyPockets` is dropped on purpose. It is a list of every unfilled cuboid with
 * its coordinates -- genuinely useful to the 3D viewer, and for a real shipment it
 * is the bulk of the payload. Spending a model's context on the coordinates of
 * nothing, when the link opens a picture of exactly that, is a poor trade. The count
 * is kept because "5 gaps" is worth knowing; the geometry is not.
 */
function summariseContainer(container, index) {
  const dims = container.containerDims ?? {};
  const round = (n) => (typeof n === "number" ? Math.round(n * 10) / 10 : null);

  return {
    index: index + 1,
    // Absent from the live response for some container choices even though the docs
    // list it, so this must not be assumed present.
    type: container.containerType ?? null,
    internalDimensionsCm: {
      length: round(dims.length),
      width: round(dims.width),
      height: round(dims.height),
    },
    itemsLoaded: container.totalQuantity ?? null,
    itemBreakdown: container.itemQuantities ?? {},
    volumeUsedPercent: round(container.volumeUsage),
    weightUsedPercent: round(container.weightUsage),
    emptyPocketCount: Array.isArray(container.emptyPockets)
      ? container.emptyPockets.length
      : 0,
  };
}

/** The whole answer, shaped for a context window rather than a viewer. */
export function summarise(payload) {
  const containers = Array.isArray(payload.containers) ? payload.containers : [];
  const unpackedTotal = payload.unpackedItems?.total ?? 0;

  return {
    containersUsed: containers.length,
    containers: containers.map(summariseContainer),
    unpacked: {
      total: unpackedTotal,
      breakdown: payload.unpackedItems?.breakdown ?? {},
    },
    // Rewritten from the `/?g=` shape the API emits, which now serves a 301 to
    // exactly this. Sending the redirect target saves every caller a hop, and means
    // a link pasted into a chat resolves without one.
    resultUrl: normaliseResultUrl(payload.linkToResult),
    everythingFits: unpackedTotal === 0 && containers.length > 0,
    plan: planForView(containers),
  };
}

/**
 * The placements, compacted for the 3D view and for nothing else -- it travels in the
 * result's `_meta`, which the host hands to the view and not to the model.
 *
 * Axes as the API reports them: x across the width, y up, z along the length. Each
 * item is `[x, y, z, width, height, length, group]`, rounded to a millimetre; a group
 * is one kind of piece -- a name and a size, whichever way it was turned -- so one
 * colour means one kind of piece. Null when the API sent no placements (the demo
 * account, or an older server), which the view reads as "link only".
 */
export function planForView(containers) {
  if (!containers.some((c) => Array.isArray(c.items) && c.items.length)) return null;

  const r = (n) => Math.round((Number(n) || 0) * 10) / 10;
  const groups = [];
  const groupIndex = new Map();

  const groupOf = (item) => {
    const sides = [item.length, item.width, item.height].map(r).sort((a, b) => b - a);
    const key = `${item.name}|${sides.join("x")}`;
    if (!groupIndex.has(key)) {
      groupIndex.set(key, groups.length);
      groups.push({ name: item.name || "Item", size: sides.join(" × ") });
    }
    return groupIndex.get(key);
  };

  return {
    groups,
    containers: containers.map((c) => ({
      length: r(c.containerDims?.length),
      width: r(c.containerDims?.width),
      height: r(c.containerDims?.height),
      items: (c.items ?? []).map((i) => [r(i.x), r(i.y), r(i.z), r(i.width), r(i.height), r(i.length), groupOf(i)]),
    })),
  };
}

/** `https://3dpack.ing?g=<id>` is the legacy share shape; `/app?g=<id>` is where it lands. */
export function normaliseResultUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get("g");
    if (!id) return url;
    return `https://3dpack.ing/app?g=${encodeURIComponent(id)}`;
  } catch {
    return url;
  }
}

/**
 * Calls the packer.
 *
 * Returns `{ ok: true, data }` or `{ ok: false, failure }` rather than throwing for
 * a failed pack: a plan limit and a malformed shipment are both ordinary answers to
 * a reasonable question, and the tool has something useful to say about each.
 * Genuine transport faults still throw.
 */
/**
 * `coordinates` asks the API for every placement, which only the 3D view uses -- the
 * text answer is built from the summary either way. The shared demo account is
 * refused placements by design (the API answers 402 before spending anything), so it
 * never asks; and should some other key be refused the same way, the pack is simply
 * repeated without them rather than failed over a picture.
 */
export async function pack({
  prompt,
  speed,
  stability,
  credentials,
  fetchImpl = fetch,
  timeoutMs = 120000,
  coordinates = !credentials.isDemo,
}) {
  const trimmed = String(prompt ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      failure: { kind: "bad_request", detail: "No shipment description was given." },
    };
  }

  const body = {
    prompt: trimmed.slice(0, MAX_PROMPT),
    apiKey: credentials.apiKey,
    username: credentials.username,
  };
  if (speed) body.speed = speed;
  // Passed through unvalidated on purpose. The packer refuses anything outside
  // 75..100 with a message rather than clamping it, and relaying that refusal is
  // more use to a caller than a second opinion here that could drift from it.
  if (stability !== undefined && stability !== null) body.stability = stability;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let text;
  try {
    const url = coordinates ? `${ENDPOINT}${ENDPOINT.includes("?") ? "&" : "?"}coordinates` : ENDPOINT;
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        ok: false,
        failure: {
          kind: "timeout",
          detail: `The solver did not answer within ${Math.round(timeoutMs / 1000)}s. A thorough pack of a large shipment can take a while -- try speed "fast".`,
        },
      };
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Not JSON, so it did not come from the API. Something in between answered --
    // a proxy, a WAF, a captive portal, an egress allowlist. Passing its actual
    // words through is the difference between "the packer is broken" and "your
    // network blocked this host", and only one of those the user can fix.
    const said = text.trim().replace(/\s+/g, " ").slice(0, 200);
    return {
      ok: false,
      failure: {
        kind: "blocked",
        detail: said
          ? `HTTP ${response.status} from something other than the API: "${said}"`
          : `HTTP ${response.status} with an empty body.`,
      },
    };
  }

  if (coordinates && response.status === 402 && /coordinates/i.test(payload?.error ?? "")) {
    return pack({ prompt, speed, stability, credentials, fetchImpl, timeoutMs, coordinates: false });
  }

  if (!response.ok || payload.error) {
    return { ok: false, failure: classifyFailure(response.status, payload) };
  }

  return {
    ok: true,
    data: summarise(payload),
    truncated: trimmed.length > MAX_PROMPT,
  };
}
