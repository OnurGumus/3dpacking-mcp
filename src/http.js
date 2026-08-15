#!/usr/bin/env node
/**
 * 3DPACK.ING as a hosted MCP server, over streamable HTTP.
 *
 * Why this exists: the npm package is an install most agent users never run, and the
 * directory that matters will not take a listing without it. Smithery's publish form
 * asks for "the HTTP URL where your MCP server is accessible" and offers no other
 * route -- so stdio alone means no listing, on the one directory where the competing
 * container-loading servers already sit with hundreds of uses.
 *
 * Sessions are stateful on purpose. Stateless would scale better and would also reset
 * the demo notice on every call, which is the exact noise server.js goes out of its
 * way to avoid; the notice is meant to be said once to a caller, and "a caller" only
 * exists if sessions do. That costs an in-memory map, so this runs as one replica and
 * sweeps idle sessions rather than growing forever.
 *
 * No dependencies beyond the SDK. An express import to route four paths would be the
 * only thing in this package that is not the SDK or Node.
 */

import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { credentialsFromConfig } from "./api.js";
import { createServer, SERVER_INFO } from "./server.js";

const PORT = Number(process.env.PORT || 8080);
const PATH = process.env.MCP_PATH || "/mcp";

/** Idle sessions are swept rather than trusted to close. A client that goes away
 *  without a DELETE is the normal case, not the exception. */
const SESSION_TTL_MS = 30 * 60 * 1000;
const SWEEP_EVERY_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 1 * 1024 * 1024;

/** sessionId -> { transport, lastSeen } */
const sessions = new Map();

function touch(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry) entry.lastSeen = Date.now();
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, entry] of sessions) {
    if (entry.lastSeen < cutoff) {
      sessions.delete(id);
      try {
        entry.transport.close();
      } catch {
        // A transport whose socket is already gone throws on close. Losing the
        // reference is the point; the throw is not interesting.
      }
    }
  }
}, SWEEP_EVERY_MS).unref();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * CORS wide open, and `Mcp-Session-Id` exposed.
 *
 * Browser-based MCP clients cannot read the session header without the expose list,
 * and a client that cannot read it cannot make a second call. The endpoint is not made
 * more abusable by this than it already is: with no credentials it runs on the shared
 * demo account, which the upstream rate-limits per key.
 */
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization, X-3dpacking-Api-Key, X-3dpacking-Username");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function jsonRpcError(res, status, code, message, id = null) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
}

const http = createHttpServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  cors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  // Liveness for the cluster, and a cheap way for a human to see what is running.
  if (url.pathname === "/healthz" || url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, server: SERVER_INFO, sessions: sessions.size, endpoint: PATH }));
    return;
  }

  if (url.pathname !== PATH) {
    jsonRpcError(res, 404, -32601, `No MCP endpoint at ${url.pathname}. Use ${PATH}.`);
    return;
  }

  const sessionId = req.headers["mcp-session-id"];

  try {
    if (req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        jsonRpcError(res, 400, -32700, "Parse error: body is not valid JSON");
        return;
      }

      if (sessionId && sessions.has(sessionId)) {
        touch(sessionId);
        await sessions.get(sessionId).transport.handleRequest(req, res, body);
        return;
      }

      if (isInitializeRequest(body)) {
        // Credentials are read once, at initialize, from whatever the client passed.
        // Every later call on this session uses them, which is what makes the session
        // worth having: a hosted endpoint otherwise has no idea who is calling.
        const credentials = credentialsFromConfig(url.searchParams, req.headers);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, { transport, lastSeen: Date.now() }),
        });

        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };

        await createServer(credentials).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      jsonRpcError(
        res,
        400,
        -32000,
        sessionId
          ? "Unknown or expired session. Send an initialize request to start a new one."
          : "Missing Mcp-Session-Id. Send an initialize request first.",
        body?.id ?? null,
      );
      return;
    }

    // GET opens the server-to-client stream; DELETE ends the session. Both need a
    // session that exists -- there is nothing to stream or tear down otherwise.
    if (req.method === "GET" || req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        jsonRpcError(res, 400, -32000, "Missing or unknown Mcp-Session-Id.");
        return;
      }
      touch(sessionId);
      await sessions.get(sessionId).transport.handleRequest(req, res);
      return;
    }

    jsonRpcError(res, 405, -32601, `Method ${req.method} not allowed on ${PATH}.`);
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }
    jsonRpcError(res, 500, -32603, `Internal error: ${error.message}`);
  }
});

http.listen(PORT, () => {
  console.log(`3dpacking MCP (streamable HTTP) listening on :${PORT}${PATH}`);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    http.close(() => process.exit(0));
  });
}
