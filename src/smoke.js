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

import { credentialsFromEnv, pack, normaliseResultUrl, classifyFailure } from "./api.js";

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

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
