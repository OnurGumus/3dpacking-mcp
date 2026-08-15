# The hosted streamable-HTTP transport. The npm package is unchanged by this and is
# still the stdio install; this image is the same code with the other entry point.
#
# Alpine and one dependency, so the image is small enough that a rebuild is not a
# reason to postpone a fix.

FROM node:22-alpine

WORKDIR /app

# Lockfile first, so a change to src/ does not reinstall the SDK.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Match the container port the deployment and service expect. `MCP_PATH` is here
# rather than hardcoded because the ingress decides the public path, and the two
# disagreeing is the failure that looks like a working server serving 404s.
ENV NODE_ENV=production \
    PORT=8080 \
    MCP_PATH=/mcp

EXPOSE 8080

# Not root. Nothing here writes to disk, so there is no reason to be able to.
USER node

CMD ["node", "src/http.js"]
