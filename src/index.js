#!/usr/bin/env node
/**
 * 3DPACK.ING as an MCP server, over stdio.
 *
 * One tool. An assistant asked "will 500 cartons fit in a 40-foot" can now answer
 * with a real pack from a real solver instead of arithmetic on volumes, which is
 * what it would otherwise do and which is wrong for anything that has to be stacked.
 *
 * The tool, the wording and the rendering live in server.js, shared with the HTTP
 * transport in http.js. This file is the stdio plumbing and nothing else.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { credentialsFromEnv } from "./api.js";
import { createServer } from "./server.js";

const server = createServer(credentialsFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);
