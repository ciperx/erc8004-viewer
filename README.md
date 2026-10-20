# erc8004-viewer

A static page that reads an agent's ERC-8004 identity and reputation on Base and Base Sepolia, and
the same logic as an ES module that runs in the browser and in Node 20. No backend, no build step,
no dependency.

Open `index.html` from any static host, type an agent id, pick a network, read.

## Deployments

From the ERC-8004 contracts repository, `erc-8004/erc-8004-contracts`, README section "Deployed
Contracts", Base and Base Sepolia entries, read on 21 October 2026:

- Base (8453): identity `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, reputation `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`
- Base Sepolia (84532): identity `0x8004A818BFB912233c491871b3d84c89A494BD9e`, reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`

`config.js` exports them as `REGISTRIES`, with the RPC each one is read through. The selectors used
are `ownerOf`, `tokenURI`, `getClients`, `getSummary` and `readAllFeedback`, taken from the ABIs in
the same repository.

## The module

```js
import { loadAgent } from "./viewer.js";

const agent = await loadAgent({ agentId: 0, network: "base-sepolia", rpc, fetchJson });
// { status, agentId, owner, tokenURI, registration, feedback, error? }
```

- `rpc(method, params)` sends one JSON-RPC call and throws an Error carrying the code and the message
  when the call fails. The page wires it to `fetch`; the tests inject it.
- `fetchJson(url)` fetches the registration file. `ipfs://` is mapped to `https://ipfs.io/ipfs/`,
  and `data:application/json` URIs, base64 or not, are decoded without a request.
- `status` is `ok`, `empty` (the owner call reverts or answers the zero address) or `error` (a call
  or the file failed, with a plain message). `loadAgent` never throws.
- `feedback` is `{count, average, items: [{client, score, tags}]}` from the reputation registry, or
  `{count: 0, average: 0, items: []}` when the agent has none. Revoked entries are dropped.

## What the page shows

The registration name, description, image, endpoints and supported trust, then the reputation as
count, average and the latest entries. One column at 360 px, two at 560 px, light and dark through
`prefers-color-scheme`, and every string breaks instead of overflowing.

## Tests

```sh
node --test test/*.test.js
```

7 tests, one per acceptance item plus the decoders. A1 to A4 inject the RPC and the file fetch. A5
checks that each network resolves its own registries and then reads agent 0 on Base Sepolia over the
public RPC, whose tokenURI is a `data:` URI, so the live check needs no file host. A6 reads the page
and asserts the viewport, the colour scheme, the width rules and the media query.

I ran it here: 7 of 7 pass, including the live Base Sepolia read.
