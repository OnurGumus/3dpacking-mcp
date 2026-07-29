# 3DPACK.ING MCP server

Container and truck load planning for AI assistants. Describe a shipment in plain
English; get back the containers it fits in, how full each one is, what did not fit,
and a link to an interactive 3D load plan.

Backed by the [3DPACK.ING](https://3dpack.ing) solver — the same one behind the web
planner. Asked "will 500 cartons fit in a 40-foot", an assistant without this will do
arithmetic on volumes, which ignores stacking rules, orientation and weight limits and
overstates what fits by a wide margin on real cargo.

## Install

Claude Desktop — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "3dpacking": {
      "command": "npx",
      "args": ["-y", "@3dpacking/mcp-server"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add 3dpacking -- npx -y @3dpacking/mcp-server
```

It works immediately, with no account — the first call runs against a shared demo
account on the free plan. For your own limits, sign up at
<https://3dpack.ing/login> and add:

```json
{
  "mcpServers": {
    "3dpacking": {
      "command": "npx",
      "args": ["-y", "@3dpacking/mcp-server"],
      "env": {
        "THREEDPACKING_API_KEY": "your-key",
        "THREEDPACKING_USERNAME": "your-username"
      }
    }
  }
}
```

Both must be set together — the API rejects a key without a username.

## The tool

**`pack_shipment`** — one required argument, `prompt`, describing the cargo in plain
English, and an optional `speed` of `fast`, `normal` or `thorough`.

Things it understands:

```
Pack 50 boxes of 60x40x30 cm into a 20ft container
Load 100 fragile items 80x60x40cm, max stack 3, into a 40ft high cube
Ship mixed pallets: 10x euro pallets, 15x US pallets, best container mix
Ship 24 pcs 200.3x120.2x100.2 cm (non-tiltable), optimal mix of 40ft and 20ft
```

What comes back:

```
Everything fits: 1 container.

Container 1 (589.3 x 235 x 239 cm internal)
  items: 50
  of which: 50x Boxes
  used: volume 10.9%
  5 empty gaps left

Interactive 3D load plan: https://3dpack.ing/app?g=6c4b9488-...
```

## Notes on the shaping

The API returns the geometry of every unfilled cuboid in every container, with
coordinates. That is what the 3D viewer needs and it is most of the payload on a real
shipment. Spending a model's context on the coordinates of empty space, when the link
opens a picture of exactly that, is a poor trade — so the summary keeps the *count* of
gaps and drops the geometry. On a small pack that is 791 bytes down to 341; on a large
one it is the difference between a usable answer and a flooded context.

A plan limit is not reported as an error. The API returns HTTP 500 for
`NotSubscribed`, the same status it uses for a solver crash; left alone, an assistant
reads that as "the service is broken" and tells the user to try again later, when what
actually happened is that they asked for a Pro feature. This server sorts the two
apart and relays the offer.

Anything that answers with non-JSON — a proxy, a VPN, a corporate egress allowlist —
is reported as a network problem naming what actually replied, rather than as a
packing failure. Only one of those is something the user can fix.

## Environment

| Variable | Purpose |
|---|---|
| `THREEDPACKING_API_KEY` | Your API key. Falls back to the shared demo account. |
| `THREEDPACKING_USERNAME` | The account the key belongs to. Required with the key. |
| `THREEDPACKING_ENDPOINT` | Override the endpoint — staging, self-hosted, or a stub. |

## Development

```bash
npm install
npm run smoke     # calls the live solver with demo credentials and checks the shape
```

`smoke.js` is deliberately not mocked for the live checks. The thing that will break
this package is 3dpack.ing changing the shape of its answer, and no amount of mocking
catches that. Run it before publishing. To exercise the success path without spending
a calculation, point `THREEDPACKING_ENDPOINT` at a stub.

## Licence

MIT.
