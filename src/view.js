/**
 * The 3D load plan as an MCP App view -- what Claude draws under a pack_shipment answer.
 *
 * A tool names its view in `_meta.ui.resourceUri`; a host that supports MCP Apps
 * reads that resource and renders it in a sandboxed iframe, then pushes the tool
 * result into it. A host that does not support them never asks, and the text answer
 * with its link is the whole of the reply -- which is why the text stays complete.
 *
 * The view draws the load itself, with Three.js from jsDelivr (`resourceDomains`).
 * It first framed the site's own viewer (`/app?g=<id>&embed=viewer`), which is the
 * better picture -- but claude.ai ignores `frameDomains` and pins `frame-src 'self'
 * blob: data:`, so the nested frame was refused (anthropics/claude-ai-mcp#40, still
 * open in Sept 2026). `resourceDomains` is honoured. If that ever changes, framing
 * the real viewer is the upgrade.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const VIEW_MIME = "text/html;profile=mcp-app";

const html = readFileSync(new URL("./load-plan.html", import.meta.url), "utf8");

/**
 * Named after its own contents. Claude caches a view by its URI: after the view
 * changed, a connector that had seen the old one kept rendering it -- still framing
 * the site, still refused -- against a server already serving the new one. A hash in
 * the name makes every change a new resource, so no cache can hold a stale one.
 */
export const VIEW_URI = `ui://3dpacking/load-plan-${createHash("sha256").update(html).digest("hex").slice(0, 12)}.html`;

export const VIEW_LISTING = {
  uri: VIEW_URI,
  name: "3D load plan",
  description: "Interactive 3D view of a packed load, shown under a pack_shipment answer.",
  mimeType: VIEW_MIME,
};

/**
 * Whether a URI names any version of this view. Claude keeps a connector's tool list
 * until the connector is re-added, so after a deploy it can still ask for the URI an
 * older build advertised. Answering that with today's view gives a stale tool list the
 * current panel; answering "unknown resource" would give it a broken one.
 */
export const isViewUri = (uri) => /^ui:\/\/3dpacking\/load-plan(?:-[0-9a-f]+)?\.html$/.test(uri);

export const viewContents = (uri = VIEW_URI) => ({
  contents: [
    {
      uri,
      mimeType: VIEW_MIME,
      text: html,
      _meta: {
        ui: {
          csp: { resourceDomains: ["https://cdn.jsdelivr.net"] },
          prefersBorder: true,
        },
        // The same two settings under ChatGPT's own names, which its Apps SDK reads.
        // Claude ignores them.
        "openai/widgetCSP": { connect_domains: [], resource_domains: ["https://cdn.jsdelivr.net"] },
        "openai/widgetPrefersBorder": true,
        // ChatGPT's app directory requires a dedicated origin for a plugin with UI. Only
        // under ChatGPT's key: the standard `ui.domain` has a host-dependent format, and
        // Claude's is not a bare origin.
        "openai/widgetDomain": "https://3dpack.ing",
      },
    },
  ],
});

