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

import { readFileSync } from "node:fs";

export const VIEW_URI = "ui://3dpacking/load-plan.html";
export const VIEW_MIME = "text/html;profile=mcp-app";

const html = readFileSync(new URL("./load-plan.html", import.meta.url), "utf8");

export const VIEW_LISTING = {
  uri: VIEW_URI,
  name: "3D load plan",
  description: "Interactive 3D view of a packed load, shown under a pack_shipment answer.",
  mimeType: VIEW_MIME,
};

export const viewContents = () => ({
  contents: [
    {
      uri: VIEW_URI,
      mimeType: VIEW_MIME,
      text: html,
      _meta: {
        ui: {
          csp: { resourceDomains: ["https://cdn.jsdelivr.net"] },
          prefersBorder: true,
        },
      },
    },
  ],
});

