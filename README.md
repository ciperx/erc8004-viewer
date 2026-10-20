# siws-solana

Sign in with Solana in one module: build the message, verify an ed25519 signature over exactly that
text, refuse a replayed nonce and check the signer against an allowlist. Node 20, no dependency.

```js
import { createMessage, verify } from "./index.js";

const message = createMessage({ domain: "app.example", address: wallet.publicKey });
// nonce, issued at and expiry are generated; pass issuedAt, expiresAt, statement, uri or chainId to override

const result = await verify({ message, signature, address, allowlist, now, seen });
// { ok: true, reason: "signed in" } or { ok: false, reason: "expired" }
```

## The message

```
app.example wants you to sign in with your Solana account:
<address>

Sign in to app.example.

URI: https://app.example
Version: 1
Chain ID: mainnet
Nonce: <base58, 16 random bytes>
Issued At: 2026-10-21T00:00:00Z
Expiration Time: 2026-10-21T00:05:00Z
```

`parseMessage` reads it back, so a caller can store the nonce and the expiry without a second parser.

## verify

The checks run in this order, each with its own reason: the message is not empty, it has a domain
line, it has an address, the address matches the one passed in, the domain matches when `domain` is
given, it has a nonce and an expiry, it has not expired, the nonce has not been used, the address is
on the allowlist when one is given, and the signature is 64 real base58 bytes that verify against
the address. `seen` is read and never written: the caller records the nonce after it accepts the
sign in, which keeps the function free of side effects. `now` accepts seconds or milliseconds.

`verify` never throws: every failure comes back as `{ok: false, reason}`.

## Tests

```sh
node --test test/*.test.js
```

7 tests, one per acceptance item plus the base58 round trip and the input checks: valid, wrong
domain (both a rewritten message and a mismatched `domain` argument), expiry boundary (the exact
expiry second still passes, the next second does not), replayed nonce, allowlist refusal, and
malformed signatures (not base58, 32 bytes, wrong signer, bad address). Wallets are real ed25519
key pairs generated per test and signed with `node:crypto`, so no fixture can drift.

I ran it here: 7 of 7 pass.
