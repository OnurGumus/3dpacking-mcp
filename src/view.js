/**
 * The 3D load plan as an MCP App view -- what Claude draws under a pack_shipment answer.
 *
 * A tool names its view in `_meta.ui.resourceUri`; a host that supports MCP Apps
 * reads that resource and renders it in a sandboxed iframe, then pushes the tool
 * result into it. A host that does not support them never asks, and the text answer
 * with its link is the whole of the reply -- which is why the text stays complete.
 *
 * The view frames https://3dpack.ing/app?g=<id>&embed=viewer. `frameDomains` is what
 * permits that: the sandbox refuses every nested frame the resource does not declare.
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
          csp: { frameDomains: ["https://3dpack.ing"] },
          prefersBorder: true,
        },
      },
    },
  ],
});

