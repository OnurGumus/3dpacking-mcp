/**
 * The tool, the wording the model sees, and how a result is read back.
 *
 * Extracted from index.js when the HTTP transport arrived. Both entry points build
 * their server from here, because the interesting content of this package is not the
 * transport -- it is `renderFailure` knowing that a plan limit is an offer rather than
 * an error, and `renderSuccess` knowing that a link to a picture beats the coordinates
 * of empty space. Two copies of that would drift, and the copy that drifted would be
 * the one a hosted caller got.
 *
 * `createServer` takes credentials rather than reading the environment, because over
 * HTTP they arrive per caller: stdio has one user for the life of the process, a
 * hosted endpoint has one per session.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { pack, SIGNUP_URL, UPGRADE_URL } from "./api.js";
import { VIEW_LISTING, VIEW_URI, isViewUri, viewContents } from "./view.js";

export const SERVER_INFO = { name: "3dpacking", version: "0.3.0" };

/**
 * How a caller gets off the demo account, which depends on how they connected.
 *
 * The stdio install reads environment variables; a hosted caller has none to set. A
 * claude.ai connector told to "set THREEDPACKING_API_KEY" has nowhere to put it, so
 * each entry point hands `createServer` the instruction its own callers can follow.
 */
export const KEY_SETUP_ENV = "set THREEDPACKING_API_KEY and THREEDPACKING_USERNAME";
export const KEY_SETUP_HOSTED =
  "connect to https://3dpack.ing/mcp?username=<your account email> with your key in an X-API-Key " +
  "header, or put both in the URL as ?apiKey=<key>&username=<email>";

export const PACK_TOOL = {
  name: "pack_shipment",
  title: "Pack a shipment into containers or trucks",
  // Hosts that support MCP Apps (Claude) draw the 3D plan under the answer; the rest
  // ignore this and relay the text, which carries the same link.
  _meta: { ui: { resourceUri: VIEW_URI } },
  description:
    "Work out how a shipment fits into shipping containers, trucks or pallets, using a real 3D bin-packing solver. " +
    "Describe the cargo in plain English -- quantities, dimensions, weights, and any constraints such as fragile, " +
    "non-tiltable, max stack height or a preferred container type -- and get back which containers are needed, how " +
    "full each one is, anything that did not fit, and a link to an interactive 3D load plan.\n\n" +
    "Use this instead of estimating from volume. Volume arithmetic ignores stacking rules, orientation and weight " +
    "limits, and overstates what fits by a wide margin on real cargo.\n\n" +
    "For cargo that must not overhang -- drums, glass, anything that must stay level -- set `stability`. It is the " +
    "one constraint the prompt cannot express, because it governs how the solver stacks rather than what is being " +
    "shipped.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The shipment, in plain English. Include quantities, dimensions with units, and weights if known. " +
          'Examples: "Pack 50 boxes of 60x40x30 cm into a 20ft container"; ' +
          '"Load 100 fragile items 80x60x40cm, max stack 3, into a 40ft high cube"; ' +
          '"Ship mixed pallets: 10x euro pallets, 15x US pallets, best container mix". ' +
          "Truncated at 4000 characters.",
      },
      speed: {
        type: "string",
        enum: ["fast", "normal", "thorough"],
        description:
          "How hard the solver should look for a better arrangement. Omit to let it choose. " +
          "Use 'fast' for a quick feasibility check, 'thorough' when the packing quality matters.",
      },
      stability: {
        type: "integer",
        minimum: 75,
        maximum: 100,
        description:
          "How much of a box must rest on what is underneath it, as a percentage of its own footprint. " +
          "Omit for the standard rule of 75, which allows a quarter of a box to overhang and packs the most. " +
          "Raise it for cargo that must not lean -- drums, glass, anything top-heavy -- and use 100 when every " +
          "stacked box has to sit fully supported. A higher value is steadier and fits fewer items, so expect " +
          "more containers or more left over.",
      },
    },
    required: ["prompt"],
  },
};

/** Renders a result the way a person would want it read back to them. */
function renderSuccess(data, { truncated }, credentials, noticeState, keySetup) {
  const lines = [];

  if (data.containersUsed === 0) {
    lines.push("The solver returned no containers. Try restating the shipment with explicit dimensions and units.");
    return lines.join("\n");
  }

  const verdict = data.everythingFits
    ? `Everything fits: ${data.containersUsed} container${data.containersUsed === 1 ? "" : "s"}.`
    : `${data.unpacked.total} item${data.unpacked.total === 1 ? "" : "s"} did not fit into ${data.containersUsed} container${data.containersUsed === 1 ? "" : "s"}.`;
  lines.push(verdict, "");

  for (const c of data.containers) {
    const d = c.internalDimensionsCm;
    const label = c.type ? `${c.type}` : `Container ${c.index}`;
    const dims = d.length ? ` (${d.length} x ${d.width} x ${d.height} cm internal)` : "";
    lines.push(`${label}${dims}`);
    lines.push(`  items: ${c.itemsLoaded}`);

    const breakdown = Object.entries(c.itemBreakdown ?? {});
    if (breakdown.length) {
      lines.push(`  of which: ${breakdown.map(([k, v]) => `${v}x ${k}`).join(", ")}`);
    }

    const usage = [];
    if (c.volumeUsedPercent != null) usage.push(`volume ${c.volumeUsedPercent}%`);
    if (c.weightUsedPercent) usage.push(`weight ${c.weightUsedPercent}%`);
    if (usage.length) lines.push(`  used: ${usage.join(", ")}`);
    if (c.emptyPocketCount) lines.push(`  ${c.emptyPocketCount} empty gaps left`);
    lines.push("");
  }

  if (data.unpacked.total > 0) {
    const b = Object.entries(data.unpacked.breakdown ?? {});
    if (b.length) lines.push(`Did not fit: ${b.map(([k, v]) => `${v}x ${k}`).join(", ")}`, "");
  }

  if (data.resultUrl) {
    lines.push(`Interactive 3D load plan: ${data.resultUrl}`);
    lines.push("(Open it to rotate the load, drag items and export the plan.)");
  }

  if (truncated) {
    lines.push("", "Note: the description was longer than 4000 characters and was truncated.");
  }

  // Said once per session, not once per call. The demo account is real and shared,
  // and a caller should know that before they put it in front of a customer -- but
  // repeating it on every pack turns a useful notice into noise the model starts
  // relaying verbatim. `noticeState` is per-server-instance, which is per-process on
  // stdio and per-session over HTTP.
  if (credentials.isDemo && !noticeState.given) {
    noticeState.given = true;
    lines.push(
      "",
      "---",
      "This ran on the shared demo account, which everybody trying this server shares. It packs up to " +
        "500 boxes at a time, and what else it will do depends on the allowance left on it that day, so " +
        `treat it as a trial rather than as a plan. For limits of your own, sign up at ${SIGNUP_URL} ` +
        `and ${keySetup}.`,
    );
  }

  return lines.join("\n");
}

/** Renders a failure as something to do next rather than a stack trace. */
function renderFailure(failure, credentials, keySetup) {
  switch (failure.kind) {
    case "plan_limit":
      // Not an error. The user asked for something real that their plan does not
      // cover, and the useful response is the offer, not an apology.
      return [
        `That pack needs a paid plan: ${failure.detail}`,
        "",
        credentials.isDemo
          ? "This ran on the shared demo account, whose allowance is shared with everyone else trying this " +
            "server. A key of your own gets your plan's limits instead."
          : "The account this key belongs to is on the free plan.",
        "",
        `Plans and upgrade: ${UPGRADE_URL}`,
        // Only when the refusal was actually about several containers. It used to be
        // offered for every plan limit, which sent a caller who had been refused for
        // sending too many boxes off to rewrite a container choice that was never the
        // problem.
        ...(/container/i.test(failure.detail ?? "")
          ? [
              "",
              "In the meantime, this will work if you pack into a single named container -- " +
                'for example "into a 40ft high cube" rather than "the best mix of 40ft and 20ft".',
            ]
          : []),
      ].join("\n");

    case "rejected_or_out_of_credit":
      return [
        `The API rejected the credentials or the account is out of credit: ${failure.detail}`,
        "",
        `Check the key and username, or top up at ${UPGRADE_URL}`,
      ].join("\n");

    case "no_credentials":
      return [
        "No API key reached the service.",
        "",
        `To use your own account, ${keySetup}. Send neither to use the demo account. Sign up at ${SIGNUP_URL}`,
      ].join("\n");

    case "bad_request": {
      // The API's own 400 is almost always the key-without-username case, and saying
      // so saves a round of guessing. But this kind also covers local validation --
      // an empty prompt -- and telling someone about credentials when they simply
      // did not describe a shipment is worse than saying nothing.
      const aboutCredentials = /username|api ?key/i.test(failure.detail ?? "");
      return [
        `The request was rejected: ${failure.detail}`,
        ...(aboutCredentials
          ? ["", "The API needs an API key and a username together, or neither."]
          : ["", "Describe the cargo with quantities, dimensions and units -- for example " +
             '"Pack 50 boxes of 60x40x30 cm into a 20ft container".']),
      ].join("\n");
    }

    case "timeout":
      return failure.detail;

    case "blocked":
      return [
        `The request never reached 3dpack.ing. ${failure.detail}`,
        "",
        "This is a network problem between you and the service, not a problem with the shipment. " +
          "Check any proxy, VPN or egress allowlist for 3dpack.ing.",
      ].join("\n");

    default:
      return [
        `The solver failed: ${failure.detail || "unknown error"}`,
        "",
        "Try restating the shipment with explicit dimensions and units.",
      ].join("\n");
  }
}

function failureIsFault(kind) {
  return kind === "server_error" || kind === "timeout" || kind === "blocked";
}

/**
 * A server bound to one caller's credentials.
 *
 * One instance per stdio process, one per HTTP session. The notice state lives on the
 * instance for that reason -- a hosted endpoint sharing it across callers would tell
 * the second caller about a demo notice the first one already saw.
 */
export function createServer(credentials, keySetup = KEY_SETUP_ENV) {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {}, resources: {} } });
  const noticeState = { given: false };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [PACK_TOOL] }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [VIEW_LISTING] }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (!isViewUri(request.params.uri)) throw new Error(`Unknown resource: ${request.params.uri}`);
    return viewContents(request.params.uri);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== PACK_TOOL.name) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }

    const { prompt, speed, stability } = request.params.arguments ?? {};

    try {
      const result = await pack({ prompt, speed, stability, credentials });

      if (result.ok) {
        return {
          content: [{ type: "text", text: renderSuccess(result.data, result, credentials, noticeState, keySetup) }],
          // For the 3D view only. `_meta` reaches the view and not the model --
          // `structuredContent` would reach both, and a large load's placements are
          // thousands of numbers no answer needs. The text above carries the link.
          _meta: {
            "ing.3dpack/resultUrl": result.data.resultUrl,
            ...(result.data.plan ? { "ing.3dpack/plan": result.data.plan } : {}),
          },
        };
      }

      // A plan limit is reported as ordinary content, not `isError`. It is a true and
      // actionable answer, and flagging it as an error is what makes an assistant
      // apologise for the service instead of relaying the offer.
      const isError = failureIsFault(result.failure.kind);
      return { isError, content: [{ type: "text", text: renderFailure(result.failure, credentials, keySetup) }] };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Could not reach 3dpack.ing: ${error.message}. The service may be down, or the network may be blocked.`,
          },
        ],
      };
    }
  });

  return server;
}
