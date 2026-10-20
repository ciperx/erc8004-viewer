/**
 * Sign in with Solana: build the message, verify an ed25519 signature over exactly that text,
 * guard against a replayed nonce and check the signer against an allowlist.
 * Node 20, one dependency free module; the ed25519 check uses node:crypto.
 */

import crypto from "node:crypto";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(bytes) {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = "";
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = "1" + out;
  }
  return out || "1";
}

export function base58Decode(text) {
  let value = 0n;
  for (const character of String(text)) {
    const index = BASE58.indexOf(character);
    if (index === -1) throw new Error("not base58");
    value = value * 58n + BigInt(index);
  }
  const bytes = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const character of String(text)) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

function randomNonce(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new Error("no secure random source");
  crypto.getRandomValues(bytes);
  return base58Encode(bytes);
}

const ISO = (value) => new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * Build the message. `params`: {domain, address, nonce?, issuedAt?, expiresAt?, statement?, uri?, chainId?}
 * A nonce and the two times are generated when they are not passed, so the caller cannot forget them.
 */
export function createMessage(params = {}) {
  const domain = String(params.domain || "").trim();
  const address = String(params.address || "").trim();
  if (!domain) throw new Error("domain is required");
  if (!address) throw new Error("address is required");

  const now = params.issuedAt ? new Date(params.issuedAt) : new Date();
  const expiresAt = params.expiresAt ? new Date(params.expiresAt) : new Date(now.getTime() + 5 * 60 * 1000);
  if (Number.isNaN(now.getTime())) throw new Error("issuedAt must be a date");
  if (Number.isNaN(expiresAt.getTime())) throw new Error("expiresAt must be a date");
  if (expiresAt.getTime() <= now.getTime()) throw new Error("expiresAt must be after issuedAt");

  const statement = params.statement === undefined ? `Sign in to ${domain}.` : String(params.statement);
  const uri = String(params.uri || `https://${domain}`);
  const chainId = String(params.chainId || "mainnet");
  const nonce = String(params.nonce || randomNonce());

  const lines = [`${domain} wants you to sign in with your Solana account:`, address, ""];
  if (statement) lines.push(statement, "");
  lines.push(`URI: ${uri}`, `Version: 1`, `Chain ID: ${chainId}`, `Nonce: ${nonce}`, `Issued At: ${ISO(now)}`, `Expiration Time: ${ISO(expiresAt)}`);
  return lines.join("\n");
}

export function parseMessage(message) {
  const lines = String(message || "").split("\n");
  const header = lines.find((line) => line.includes("wants you to sign in with your Solana account:")) || "";
  const domain = header.replace(/\s*wants you to sign in with your Solana account:\s*$/, "").trim();
  const addressIndex = lines.indexOf(header) + 1;
  const address = (lines[addressIndex] || "").trim();
  const field = (name) => {
    const line = lines.find((candidate) => candidate.startsWith(`${name}: `));
    return line ? line.slice(name.length + 2).trim() : undefined;
  };
  return { domain, address, uri: field("URI"), chainId: field("Chain ID"), nonce: field("Nonce"), issuedAt: field("Issued At"), expirationTime: field("Expiration Time") };
}

function verifyEd25519(message, signature, address) {
  const raw = base58Decode(address);
  if (raw.length !== 32) throw new Error("address must decode to 32 bytes");
  // SubjectPublicKeyInfo for Ed25519: 302a300506032b6570032100 then the 32 byte key
  const prefix = Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
  const key = crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(raw)]), format: "der", type: "spki" });
  return crypto.verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature));
}

function allowlistHas(allowlist, address) {
  if (!allowlist) return true;
  const list = allowlist instanceof Set ? [...allowlist] : allowlist;
  if (!Array.isArray(list) || list.length === 0) return true;
  return list.includes(address);
}

/**
 * verify({message, signature, address, allowlist?, domain?, now?, seen?}) -> {ok, reason}
 * `signature` is a base58 string or bytes, `now` is seconds or milliseconds, `seen` is read and never
 * written: the caller records the nonce after it accepts the sign in.
 */
export async function verify({ message, signature, address, allowlist, domain, now, seen } = {}) {
  try {
    if (typeof message !== "string" || !message.trim()) return { ok: false, reason: "message is empty" };
    const fields = parseMessage(message);
    if (!fields.domain) return { ok: false, reason: "the message has no domain line" };
    if (!fields.address) return { ok: false, reason: "the message has no address" };
    if (address && fields.address !== address) return { ok: false, reason: "the message is for another address" };
    if (domain && fields.domain.toLowerCase() !== String(domain).toLowerCase()) return { ok: false, reason: "wrong domain" };
    if (!fields.nonce) return { ok: false, reason: "the message has no nonce" };
    if (!fields.expirationTime) return { ok: false, reason: "the message has no expiry" };

    const nowMs = now === undefined ? Date.now() : Number(now) < 1e12 ? Number(now) * 1000 : Number(now);
    const expiry = Date.parse(fields.expirationTime);
    if (Number.isNaN(expiry)) return { ok: false, reason: "unreadable expiry" };
    if (nowMs > expiry) return { ok: false, reason: "expired" };

    const used = seen instanceof Set ? seen : new Set(Array.isArray(seen) ? seen : []);
    if (used.has(fields.nonce)) return { ok: false, reason: "nonce already used" };

    const signer = address || fields.address;
    if (!allowlistHas(allowlist, signer)) return { ok: false, reason: "address not on the allowlist" };

    let bytes;
    try {
      bytes = typeof signature === "string" ? base58Decode(signature) : new Uint8Array(signature ?? []);
    } catch {
      return { ok: false, reason: "signature is not base58" };
    }
    if (bytes.length !== 64) return { ok: false, reason: `malformed signature: ${bytes.length} bytes instead of 64` };

    let valid = false;
    try {
      valid = verifyEd25519(message, bytes, signer);
    } catch (error) {
      return { ok: false, reason: `malformed signature: ${error.message}` };
    }
    if (!valid) return { ok: false, reason: "signature does not match the address" };
    return { ok: true, reason: "signed in" };
  } catch (error) {
    return { ok: false, reason: error?.message || "verification failed" };
  }
}

export default { createMessage, verify, parseMessage, base58Encode, base58Decode };
