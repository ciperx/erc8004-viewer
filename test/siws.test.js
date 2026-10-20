import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createMessage, verify, parseMessage, base58Encode, base58Decode } from "../index.js";

function wallet() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(12);
  const address = base58Encode(new Uint8Array(raw));
  const sign = (message) => base58Encode(new Uint8Array(crypto.sign(null, Buffer.from(message, "utf8"), privateKey)));
  return { address, sign, privateKey };
}

const NOW = Date.parse("2026-10-21T00:00:00Z");

test("A1 a valid sign in passes, and the message carries every field the format promises", async () => {
  const { address, sign } = wallet();
  const message = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 300_000, nonce: "nonceOne" });
  const fields = parseMessage(message);
  assert.equal(fields.domain, "app.example");
  assert.equal(fields.address, address);
  assert.equal(fields.nonce, "nonceOne");
  assert.equal(fields.chainId, "mainnet");
  assert.equal(fields.uri, "https://app.example");
  assert.match(message, /^app\.example wants you to sign in with your Solana account:\n/);

  const result = await verify({ message, signature: sign(message), address, allowlist: [address], now: NOW / 1000 });
  assert.deepEqual(result, { ok: true, reason: "signed in" });
});

test("A2 a signature made for another domain, or a message rewritten after signing, fails", async () => {
  const { address, sign } = wallet();
  const message = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 300_000, nonce: "n1" });
  const signature = sign(message);

  const otherDomain = message.replace("app.example wants", "evil.example wants");
  const wrongDomain = await verify({ message: otherDomain, signature, address, now: NOW });
  assert.equal(wrongDomain.ok, false);
  assert.match(wrongDomain.reason, /wrong domain|does not match/);

  const checked = await verify({ message, signature, address, domain: "evil.example", now: NOW });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, "wrong domain");

  const tampered = message.replace(address, address);
  assert.equal((await verify({ message: tampered + "\n", signature, address, now: NOW })).ok, false);
});

test("A3 an expired message fails, and the boundary is inclusive of the expiry second", async () => {
  const { address, sign } = wallet();
  const message = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 60_000, nonce: "n2" });
  const atExpiry = await verify({ message, signature: sign(message), address, now: (NOW + 60_000) / 1000 });
  assert.equal(atExpiry.ok, true);
  const late = await verify({ message, signature: sign(message), address, now: (NOW + 61_000) / 1000 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "expired");
});

test("A4 a replayed nonce is refused, and a fresh nonce from the same wallet still passes", async () => {
  const { address, sign } = wallet();
  const first = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 300_000, nonce: "used" });
  const signature = sign(first);
  const seen = new Set(["used"]);
  const replay = await verify({ message: first, signature, address, now: NOW, seen });
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, "nonce already used");

  const second = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 300_000, nonce: "fresh" });
  const fresh = await verify({ message: second, signature: sign(second), address, now: NOW, seen });
  assert.equal(fresh.ok, true);
  assert.equal(seen.size, 1, "verify must not record the nonce itself");
});

test("A5 an address off the allowlist is refused, and an empty allowlist means open", async () => {
  const { address, sign } = wallet();
  const other = wallet();
  const message = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 300_000, nonce: "n5" });
  const signature = sign(message);

  const refused = await verify({ message, signature, address, allowlist: [other.address], now: NOW });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "address not on the allowlist");

  assert.equal((await verify({ message, signature, address, allowlist: [], now: NOW })).ok, true);
  assert.equal((await verify({ message, signature, address, allowlist: new Set([address]), now: NOW })).ok, true);
});

test("A6 a malformed signature is refused with a reason, never a throw", async () => {
  const { address, sign } = wallet();
  const message = createMessage({ domain: "app.example", address, issuedAt: NOW, expiresAt: NOW + 300_000, nonce: "n6" });

  const notBase58 = await verify({ message, signature: "0OIl", address, now: NOW });
  assert.equal(notBase58.ok, false);
  assert.match(notBase58.reason, /not base58/);

  const short = await verify({ message, signature: base58Encode(new Uint8Array(32)), address, now: NOW });
  assert.equal(short.ok, false);
  assert.match(short.reason, /malformed signature: 32 bytes/);

  const wrongSigner = await verify({ message, signature: sign(message), address: wallet().address, now: NOW });
  assert.equal(wrongSigner.ok, false);
  assert.match(wrongSigner.reason, /another address|does not match/);

  const badAddress = await verify({ message, signature: sign(message), address: "not-a-real-address", now: NOW });
  assert.equal(badAddress.ok, false);

  const empty = await verify({});
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "message is empty");
});

test("base58 round trips and the message refuses incomplete input", () => {
  const bytes = new Uint8Array([0, 0, 1, 2, 3, 250, 255]);
  assert.deepEqual([...base58Decode(base58Encode(bytes))], [...bytes]);
  assert.throws(() => createMessage({ address: "x" }), /domain is required/);
  assert.throws(() => createMessage({ domain: "d" }), /address is required/);
  assert.throws(() => createMessage({ domain: "d", address: "a", issuedAt: NOW, expiresAt: NOW }), /after issuedAt/);
});
