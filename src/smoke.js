/**
 * Hits the live endpoint and checks the shaping still matches what comes back.
 *
 * Not a unit test. The thing that will break this package is 3dpack.ing changing the
 * shape of its answer, and no amount of mocking catches that -- so this calls the
 * real solver with the demo credentials the docs hand out, and asserts on what
 * returns. Run it before publishing, and after any change to the API.
 *
 *   node src/smoke.js
 */

import { credentialsFromConfig, credentialsFromEnv, pack, normaliseResultUrl, classifyFailure, planForView } from "./api.js";
import { PACK_TOOL } from "./server.js";
import { VIEW_URI, isViewUri, viewContents } from "./view.js";

let failures = 0;

function check(label, condition, detail = "") {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`${mark}  ${label}${detail ? ` -- ${detail}` : ""}`);
}

// --- pure, no network -------------------------------------------------------

check(
  "legacy result URL is rewritten to /app",
  normaliseResultUrl("https://3dpack.ing?g=abc-123") === "https://3dpack.ing/app?g=abc-123",
);

check("null result URL survives", normaliseResultUrl(null) === null);

check(
  "NotSubscribed is classified as a plan limit, not a server fault",
  classifyFailure(500, { error: 'Calculation failed: [NotSubscribed "Packing several containers at once is part of Pro."]' })
    .kind === "plan_limit",
);

check(
  "a real 500 stays a server error",
  classifyFailure(500, { error: "Calculation failed: solver crashed" }).kind === "server_error",
);

check(
  "empty prompt is refused before it reaches the network",
  (await pack({ prompt: "   ", credentials: { apiKey: "x", username: "y" } })).failure.kind ===
    "bad_request",
);

const query = (s) => new URLSearchParams(s);

check(
  "a connector's X-API-Key header pairs with ?username",
  credentialsFromConfig(query("username=a@b.c"), { "x-api-key": "k1" }).apiKey === "k1",
);

check(
  "Authorization: Bearer carries the key",
  credentialsFromConfig(query("username=a@b.c"), { authorization: "Bearer k2" }).apiKey === "k2",
);

check(
  "a bare Authorization value carries the key too",
  credentialsFromConfig(query("username=a@b.c"), { authorization: "k3" }).apiKey === "k3",
);

check(
  "Basic auth is not mistaken for a key",
  credentialsFromConfig(query("username=a@b.c"), { authorization: "Basic eDp5" }).isDemo,
);

check(
  "the query-string key still wins over a header",
  credentialsFromConfig(query("apiKey=q&username=a@b.c"), { "x-api-key": "h" }).apiKey === "q",
);

check(
  "an OAuth access token carries its own account",
  (() => {
    const c = credentialsFromConfig(query(""), { authorization: "Bearer 3dp." + Buffer.from("rj@example.com").toString("base64url") + ".k9" });
    return c.username === "rj@example.com" && c.apiKey === "k9" && !c.isDemo && !c.anonymous;
  })(),
);

check("no credential at all is anonymous, so the transport can ask for sign-in", credentialsFromConfig(query(""), {}).anonymous === true);

check(
  "a key with no username still falls back to the demo pair",
  credentialsFromConfig(query(""), { "x-api-key": "k1" }).isDemo,
);

const view = viewContents().contents[0];

check("pack_shipment names the 3D view for MCP Apps hosts", PACK_TOOL._meta?.ui?.resourceUri === VIEW_URI);

check(
  "an older view URI still gets today's view, anything else does not",
  isViewUri("ui://3dpacking/load-plan-09e0cc1c6f50.html") && isViewUri("ui://3dpacking/load-plan.html") && !isViewUri("ui://other/x.html"),
);

check("the view is served as an MCP App", view.mimeType === "text/html;profile=mcp-app" && view.text.includes("ui/initialize"));

check(
  "the view may load scripts from jsDelivr and nothing else",
  JSON.stringify(view._meta.ui.csp) === JSON.stringify({ resourceDomains: ["https://cdn.jsdelivr.net"] }),
);

{
  const plan = planForView([
    {
      containerDims: { length: 589.28, width: 235, height: 239 },
      items: [
        { name: "Boxes", length: 50, width: 100, height: 200, x: 0, y: 0, z: 0 },
        { name: "Boxes", length: 100, width: 50, height: 200, x: 100, y: 0, z: 0 },
        { name: "Boxes", length: 40, width: 60, height: 150, x: 160, y: 0, z: 50 },
      ],
    },
  ]);
  check(
    "placements compact to [x, y, z, width, height, length, group]",
    JSON.stringify(plan.containers[0].items[0]) === JSON.stringify([0, 0, 0, 100, 200, 50, 0]),
  );
  check("a turned piece stays in its own kind's group", plan.containers[0].items[1][6] === 0 && plan.groups.length === 2);
  check("no placements means no plan, not an empty one", planForView([{ containerDims: {}, items: [] }]) === null);
}

// --- live ------------------------------------------------------------------

const credentials = credentialsFromEnv();
console.log(`\nCalling the live solver as ${credentials.isDemo ? "the demo account" : credentials.username}...\n`);

const single = await pack({
  prompt: "Pack 50 boxes of 60x40x30 cm into a 20ft container",
  credentials,
});

check("single-container pack succeeds", single.ok, single.ok ? "" : JSON.stringify(single.failure));

if (single.ok) {
  check("a container came back", single.data.containersUsed >= 1);
  check("items were loaded", (single.data.containers[0]?.itemsLoaded ?? 0) > 0);
  check("volume usage is present", single.data.containers[0]?.volumeUsedPercent != null);
  check(
    "result URL points at /app",
    (single.data.resultUrl ?? "").includes("/app?g="),
    single.data.resultUrl ?? "none",
  );
  check(
    "empty pocket geometry is not in the summary",
    !JSON.stringify(single.data).includes('"x":'),
  );
  console.log(`\n  summary size: ${JSON.stringify(single.data).length} bytes\n`);
}

// The documented multi-container prompt. On the free plan this is expected to come
// back as a plan limit -- and the point of the check is that it arrives labelled as
// one rather than as a 500.
const multi = await pack({
  prompt: "Ship 24 pcs 200x120x100 cm 400kg each, non-tiltable, using an optimal mix of 40ft and 20ft containers",
  credentials,
});

if (multi.ok) {
  check("multi-container pack succeeded (paid key)", true);
} else {
  check(
    "multi-container refusal is labelled a plan limit",
    multi.failure.kind === "plan_limit",
    multi.failure.kind,
  );
}

// Stability is a solver setting rather than a description, so the only proof it is
// wired is that the same shipment answers differently at the two ends of the range.
// 100 demands every stacked box sit fully on what is under it, so it can only ever
// seat the same or fewer -- if the two packs are identical the parameter is being
// dropped somewhere between here and the engine, which is exactly how `speed` was
// advertised and inert for months.
const steady = await pack({
  prompt: "Pack 50 boxes of 60x40x30 cm into a 20ft container",
  stability: 100,
  credentials,
});

check("stability=100 is accepted", steady.ok, steady.ok ? "" : JSON.stringify(steady.failure));

if (steady.ok && single.ok) {
  const loose = single.data.containers[0]?.itemsLoaded ?? 0;
  const strict = steady.data.containers[0]?.itemsLoaded ?? 0;
  check(
    "stability=100 never seats more than the default rule",
    strict <= loose,
    `75 seated ${loose}, 100 seated ${strict}`,
  );
}

// Out of range falls back to the documented default rather than being clamped to the
// nearest legal value: 50 is not "as loose as possible", it is a caller asking for
// something the schema never published, and answering it with the standard rule is
// the one behaviour that cannot silently pack to a rule nobody asked for.
const outOfRange = await pack({
  prompt: "Pack 50 boxes of 60x40x30 cm into a 20ft container",
  stability: 50,
  credentials,
});

check("an out-of-range stability still packs", outOfRange.ok, outOfRange.ok ? "" : JSON.stringify(outOfRange.failure));

if (outOfRange.ok && single.ok) {
  check(
    "an out-of-range stability falls back to the default rule",
    (outOfRange.data.containers[0]?.itemsLoaded ?? -1) === (single.data.containers[0]?.itemsLoaded ?? -2),
    `default seated ${single.data.containers[0]?.itemsLoaded}, 50 seated ${outOfRange.data.containers[0]?.itemsLoaded}`,
  );
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
