#!/usr/bin/env node
/**
 * 3DPACK.ING as an MCP server.
 *
 * One tool. An assistant asked "will 500 cartons fit in a 40-foot" can now answer
 * with a real pack from a real solver instead of arithmetic on volumes, which is
 * what it would otherwise do and which is wrong for anything that has to be stacked.
 *
 * Everything about the shape of the answer is in api.js; this file is the MCP
 * plumbing and the wording the model sees.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { credentialsFromEnv, pack, SIGNUP_URL, UPGRADE_URL } from "./api.js";

const credentials = credentialsFromEnv();

/**
 * Said once per session, not once per call.
 *
 * The demo account is real and shared, and a caller should know that before they
 * put it in front of a customer -- but repeating it on every pack turns a useful
 * notice into noise the model starts relaying verbatim.
 */
let demoNoticeGiven = false;

const PACK_TOOL = {
  name: "pack_shipment",
  title: "Pack a shipment into containers or trucks",
  description:
    "Work out how a shipment fits into shipping containers, trucks or pallets, using a real 3D bin-packing solver. " +
    "Describe the cargo in plain English -- quantities, dimensions, weights, and any constraints such as fragile, " +
    "non-tiltable, max stack height or a preferred container type -- and get back which containers are needed, how " +
    "full each one is, anything that did not fit, and a link to an interactive 3D load plan.\n\n" +
    "Use this instead of estimating from volume. Volume arithmetic ignores stacking rules, orientation and weight " +
    "limits, and overstates what fits by a wide margin on real cargo.",
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
    },
    required: ["prompt"],
  },
};

const server = new Server(
  { name: "3dpacking", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [PACK_TOOL] }));

/** Renders a result the way a person would want it read back to them. */
function renderSuccess(data, { truncated }) {
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

  if (credentials.isDemo && !demoNoticeGiven) {
    demoNoticeGiven = true;
    lines.push(
      "",
      "---",
      "This ran on the shared demo account, which is on the free plan: single-container packs only, " +
        `and a limited number per month. For your own key and higher limits, sign up at ${SIGNUP_URL} ` +
        "and set THREEDPACKING_API_KEY and THREEDPACKING_USERNAME.",
    );
  }

  return lines.join("\n");
}

/** Renders a failure as something to do next rather than a stack trace. */
function renderFailure(failure) {
  switch (failure.kind) {
    case "plan_limit":
      // Not an error. The user asked for something real that their plan does not
      // cover, and the useful response is the offer, not an apology.
      return [
        `That pack needs a paid plan: ${failure.detail}`,
        "",
        credentials.isDemo
          ? "This ran on the shared demo account, which is on the free plan. Multi-container optimisation, " +
            "larger shipments and higher monthly limits are on the paid plans."
          : "The account this key belongs to is on the free plan.",
        "",
        `Plans and upgrade: ${UPGRADE_URL}`,
        "",
        "In the meantime, this will work if you pack into a single named container -- " +
          'for example "into a 40ft high cube" rather than "the best mix of 40ft and 20ft".',
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
        `Set THREEDPACKING_API_KEY and THREEDPACKING_USERNAME, or omit both to use the demo account. Sign up at ${SIGNUP_URL}`,
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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== PACK_TOOL.name) {
    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
    };
  }

  const { prompt, speed } = request.params.arguments ?? {};

  try {
    const result = await pack({ prompt, speed, credentials });

    if (result.ok) {
      return { content: [{ type: "text", text: renderSuccess(result.data, result) }] };
    }

    // A plan limit is reported as ordinary content, not `isError`. It is a true and
    // actionable answer, and flagging it as an error is what makes an assistant
    // apologise for the service instead of relaying the offer.
    const isError = failureIsFault(result.failure.kind);
    return { isError, content: [{ type: "text", text: renderFailure(result.failure) }] };
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

function failureIsFault(kind) {
  return kind === "server_error" || kind === "timeout" || kind === "blocked";
}

const transport = new StdioServerTransport();
await server.connect(transport);
