/**
 * ERC-8004 identity viewer: read an agent's owner and registration file, plus its reputation,
 * on Base or Base Sepolia. Browser and Node 20, no dependency, no backend.
 */

export const REGISTRIES = {
  base: {
    identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputation: "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63",
  },
  "base-sepolia": {
    identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  },
};

export const SELECTORS = {
  ownerOf: "0x6352211e",
  tokenURI: "0xc87b56dd",
  getClients: "0x42dd519c",
  getSummary: "0x81bbba58",
  readAllFeedback: "0xd9d84224",
};

const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ---------- ABI encoding ----------

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function encodeAddress(address) {
  return String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function bytesHex(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function encodeString(text) {
  const data = bytesHex(text);
  const padded = data.padEnd(Math.ceil(data.length / 64) * 64, "0");
  return word(data.length / 2) + padded;
}

function encodeAddressArray(addresses) {
  let out = word(addresses.length);
  for (const address of addresses) out += encodeAddress(address);
  return out;
}

function headAndTails(statics, tails) {
  let offset = statics.length * 32 + tails.length * 32;
  let head = "";
  for (const value of statics) head += value;
  let body = "";
  for (const tail of tails) {
    head += word(offset);
    body += tail;
    offset += tail.length / 2;
  }
  return head + body;
}

export function encodeGetSummary(agentId, clients, tag1, tag2) {
  return SELECTORS.getSummary + headAndTails([word(agentId)], [encodeAddressArray(clients), encodeString(tag1), encodeString(tag2)]);
}

export function encodeReadAllFeedback(agentId, clients, tag1, tag2, includeRevoked) {
  return (
    SELECTORS.readAllFeedback +
    headAndTails([word(agentId), includeRevoked ? word(1) : word(0)], [encodeAddressArray(clients), encodeString(tag1), encodeString(tag2)])
  );
}

// ---------- ABI decoding ----------

function strip(hex) {
  return String(hex || "0x").replace(/^0x/, "");
}

function at(data, offset) {
  return data.slice(offset * 2, offset * 2 + 64);
}

function readUint(data, slot) {
  return BigInt("0x" + (at(data, slot * 32) || "0"));
}

function readInt128(data, slot) {
  const raw = readUint(data, slot);
  return raw >= 1n << 127n ? raw - (1n << 256n) : raw;
}

function readStringAt(data, byteOffset) {
  const length = Number(BigInt("0x" + (data.slice(byteOffset * 2, byteOffset * 2 + 64) || "0")));
  const body = data.slice(byteOffset * 2 + 64, byteOffset * 2 + 64 + length * 2);
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = parseInt(body.slice(index * 2, index * 2 + 2) || "0", 16);
  return new TextDecoder().decode(bytes);
}

/** One string return value, as `tokenURI` and friends encode it. */
export function decodeString(hex) {
  const data = strip(hex);
  const offset = Number(readUint(data, 0));
  return readStringAt(data, offset);
}

/** address[] return value. */
export function decodeAddressArray(hex) {
  const data = strip(hex);
  const offset = Number(readUint(data, 0));
  const length = Number(BigInt("0x" + data.slice(offset * 2, offset * 2 + 64)));
  const out = [];
  for (let index = 0; index < length; index += 1) {
    const raw = data.slice(offset * 2 + 64 + index * 64, offset * 2 + 128 + index * 64);
    out.push("0x" + raw.slice(24));
  }
  return out;
}

/** getSummary returns (uint64 count, int128 value, uint8 decimals). */
export function decodeSummary(hex) {
  const data = strip(hex);
  return {
    count: Number(readUint(data, 0)),
    value: readInt128(data, 1),
    decimals: Number(readUint(data, 2)),
  };
}

/** readAllFeedback returns seven arrays in one tuple. */
export function decodeFeedback(hex) {
  const data = strip(hex);
  const offsets = [];
  for (let slot = 0; slot < 7; slot += 1) offsets.push(Number(readUint(data, slot)));

  const countAt = (offset) => Number(BigInt("0x" + data.slice(offset * 2, offset * 2 + 64)));
  const clientsCount = countAt(offsets[0]);
  const clients = [];
  for (let index = 0; index < clientsCount; index += 1) {
    const raw = data.slice(offsets[0] * 2 + 64 + index * 64, offsets[0] * 2 + 128 + index * 64);
    clients.push("0x" + raw.slice(24));
  }

  const numbers = (offset) => {
    const length = countAt(offset);
    const out = [];
    for (let index = 0; index < length; index += 1) {
      const raw = data.slice(offset * 2 + 64 + index * 64, offset * 2 + 128 + index * 64);
      out.push(BigInt("0x" + raw));
    }
    return out;
  };

  const values = numbers(offsets[2]).map((value) => (value >= 1n << 127n ? value - (1n << 256n) : value));
  const decimals = numbers(offsets[3]).map((value) => Number(value));
  const tag1s = numbers(offsets[4]).map((_, index) => {
    const elementOffset = Number(BigInt("0x" + data.slice(offsets[4] * 2 + 64 + index * 64, offsets[4] * 2 + 128 + index * 64)));
    return readStringAt(data, offsets[4] + 32 + elementOffset);
  });
  const tag2s = numbers(offsets[5]).map((_, index) => {
    const elementOffset = Number(BigInt("0x" + data.slice(offsets[5] * 2 + 64 + index * 64, offsets[5] * 2 + 128 + index * 64)));
    return readStringAt(data, offsets[5] + 32 + elementOffset);
  });
  const revoked = numbers(offsets[6]).map((value) => value !== 0n);
  const indexes = numbers(offsets[1]);

  const items = [];
  for (let index = 0; index < clients.length; index += 1) {
    items.push({
      client: clients[index],
      index: Number(indexes[index] ?? 0n),
      score: Number(values[index] ?? 0n) / 10 ** (decimals[index] ?? 0),
      tags: [tag1s[index], tag2s[index]].filter(Boolean),
      revoked: Boolean(revoked[index]),
    });
  }
  return items;
}

// ---------- registration files ----------

export function resolveTokenURI(tokenURI, gateway = IPFS_GATEWAY) {
  const uri = String(tokenURI || "").trim();
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const path = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return gateway + path;
  }
  return uri;
}

function decodeDataUri(uri) {
  if (uri.startsWith("data:application/json;base64,")) {
    const base64 = uri.slice("data:application/json;base64,".length);
    const text = typeof atob === "function" ? atob(base64) : Buffer.from(base64, "base64").toString("binary");
    return JSON.parse(inflate(text));
  }
  if (uri.startsWith("data:application/json,")) {
    return JSON.parse(inflate(decodeURIComponent(uri.slice("data:application/json,".length))));
  }
  return undefined;
}

function inflate(text) {
  return typeof text === "string" ? text : new TextDecoder().decode(text);
}

async function readRegistration(tokenURI, fetchJson, gateway) {
  const decoded = decodeDataUri(tokenURI);
  if (decoded !== undefined) return decoded;
  const url = resolveTokenURI(tokenURI, gateway);
  if (!url) throw new Error("the agent has an empty tokenURI");
  const body = await fetchJson(url);
  if (typeof body === "string") return JSON.parse(body);
  return body;
}

// ---------- the loader ----------

function messageOf(error) {
  if (!error) return "unknown error";
  const code = error.code !== undefined ? ` (code ${error.code})` : "";
  return `${error.message || String(error)}${code}`;
}

function isMissingAgent(error) {
  const text = String(error?.message || "");
  return error?.code === 3 || /revert/i.test(text) || /invalid token/i.test(text);
}

/**
 * Read one agent. Never throws: a missing agent answers status "empty", a failed call or file
 * answers status "error" with a plain message, and everything else answers status "ok".
 */
export async function loadAgent({ agentId, network = "base", identityRegistry, reputationRegistry, rpc, fetchJson, gateway } = {}) {
  const registries = REGISTRIES[network] || REGISTRIES.base;
  const identity = identityRegistry || registries.identity;
  const reputation = reputationRegistry === undefined ? registries.reputation : reputationRegistry;
  const id = String(agentId ?? "").trim();

  if (!/^\d+$/.test(id)) return { status: "error", agentId: id, error: "agentId must be a decimal integer" };
  if (typeof rpc !== "function") return { status: "error", agentId: id, error: "rpc is required" };
  if (typeof fetchJson !== "function") return { status: "error", agentId: id, error: "fetchJson is required" };

  let owner;
  try {
    const result = await rpc("eth_call", [{ to: identity, data: SELECTORS.ownerOf + word(id) }, "latest"]);
    owner = "0x" + strip(result).slice(-40).toLowerCase();
  } catch (error) {
    if (isMissingAgent(error)) return { status: "empty", agentId: id, error: `no agent ${id} on ${network}` };
    return { status: "error", agentId: id, error: messageOf(error) };
  }
  if (owner === ZERO_ADDRESS) return { status: "empty", agentId: id, error: `no agent ${id} on ${network}` };

  let tokenURI = "";
  try {
    tokenURI = decodeString(await rpc("eth_call", [{ to: identity, data: SELECTORS.tokenURI + word(id) }, "latest"]));
  } catch (error) {
    const text = String(error?.message || "");
    if (!/revert/i.test(text)) return { status: "error", agentId: id, owner, error: messageOf(error) };
  }

  let registration = null;
  try {
    registration = await readRegistration(tokenURI, fetchJson, gateway || IPFS_GATEWAY);
  } catch (error) {
    return { status: "error", agentId: id, owner, tokenURI, error: `the registration file could not be read: ${messageOf(error)}` };
  }

  let feedback = { count: 0, average: 0, items: [] };
  if (reputation) {
    try {
      const clients = decodeAddressArray(await rpc("eth_call", [{ to: reputation, data: SELECTORS.getClients + word(id) }, "latest"]));
      if (clients.length > 0) {
        const raw = await rpc("eth_call", [{ to: reputation, data: encodeReadAllFeedback(id, clients, "", "", false) }, "latest"]);
        const items = decodeFeedback(raw).filter((item) => !item.revoked);
        const total = items.reduce((sum, item) => sum + item.score, 0);
        feedback = { count: items.length, average: items.length ? Math.round((total / items.length) * 100) / 100 : 0, items };
      }
    } catch (error) {
      feedback = { count: 0, average: 0, items: [], error: messageOf(error) };
    }
  }

  return { status: "ok", agentId: id, network, identityRegistry: identity, reputationRegistry: reputation || null, owner, tokenURI, registration, feedback };
}

export default { loadAgent, REGISTRIES, SELECTORS, decodeString, decodeAddressArray, decodeSummary, decodeFeedback, resolveTokenURI };
