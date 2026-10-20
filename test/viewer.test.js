import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadAgent, REGISTRIES, resolveTokenURI, decodeString, decodeFeedback } from "../viewer.js";

const OWNER = "0x1111111111111111111111111111111111111111";

const w = (value) => BigInt(value).toString(16).padStart(64, "0");
const addr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function encString(text) {
  const bytes = [...new TextEncoder().encode(text)];
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
  return w(32) + w(bytes.length) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
}

function encAddressArray(list) {
  return w(32) + w(list.length) + list.map(addr).join("");
}

function encFeedback({ clients, values, decimals, tags1, tags2, revoked }) {
  let head = "";
  const parts = [];
  const bodies = [];
  const push = (body) => bodies.push(body);

  push(encAddressArray(clients).slice(64));
  push(w(clients.length) + clients.map((_, i) => w(i + 1)).join(""));
  push(w(values.length) + values.map((v) => w(v)).join(""));
  push(w(decimals.length) + decimals.map((d) => w(d)).join(""));

  const stringArray = (items) => {
    const encoded = items.map((s) => {
      const bytes = [...new TextEncoder().encode(s)];
      const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
      const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
      return { length: bytes.length, padded };
    });
    let offset = items.length * 32;
    let heads = "";
    let tails = "";
    for (const item of encoded) {
      heads += w(offset);
      tails += w(item.length) + item.padded;
      offset += 32 + item.padded.length / 2;
    }
    return w(items.length) + heads + tails;
  };

  push(stringArray(tags1));
  push(stringArray(tags2));
  push(w(revoked.length) + revoked.map((r) => w(r ? 1 : 0)).join(""));

  let offset = 7 * 32;
  let headOut = head;
  let body = "";
  for (const part of bodies) {
    headOut += w(offset);
    body += part;
    offset += part.length / 2;
  }
  return headOut + body;
}

function fakeRpc(handlers) {
  const calls = [];
  const rpc = async (method, params) => {
    const data = params[0].data;
    calls.push({ method, to: params[0].to, data });
    for (const [prefix, value] of Object.entries(handlers)) {
      if (data.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return typeof value === "function" ? value(data) : value;
      }
    }
    throw Object.assign(new Error("unexpected call " + data.slice(0, 10)), { code: -32601 });
  };
  rpc.calls = calls;
  return rpc;
}

const IDENTITY = REGISTRIES.base.identity;
const REPUTATION = REGISTRIES.base.reputation;

test("A1 an existing agent shows its owner, its tokenURI and its registration file", async () => {
  const uri = "ipfs://bafybeigdyrzt/agent.json";
  const rpc = fakeRpc({
    "0x6352211e": addr(OWNER),
    "0xc87b56dd": encString(uri),
    "0x42dd519c": encAddressArray([]),
  });
  const fetchJson = async (url) => {
    assert.equal(url, "https://ipfs.io/ipfs/bafybeigdyrzt/agent.json");
    return { name: "Garuda", description: "a tester", image: "ipfs://bafy/image.png", endpoints: [{ name: "web", url: "https://example.test" }], supportedTrust: ["reputation"] };
  };
  const result = await loadAgent({ agentId: 7, network: "base", rpc, fetchJson });
  assert.equal(result.status, "ok");
  assert.equal(result.owner, OWNER);
  assert.equal(result.tokenURI, uri);
  assert.equal(result.registration.name, "Garuda");
  assert.equal(result.registration.endpoints[0].url, "https://example.test");
  assert.equal(rpc.calls[0].to, IDENTITY);
});

test("A2 ipfs and data tokenURIs are read without a request", async () => {
  assert.equal(resolveTokenURI("ipfs://ipfs/QmHash/file.json"), "https://ipfs.io/ipfs/QmHash/file.json");

  const payload = { name: "Sealed", description: "base64 agent", supportedTrust: ["crypto"] };
  const base64 = Buffer.from(JSON.stringify(payload)).toString("base64");
  const rpc = fakeRpc({
    "0x6352211e": addr(OWNER),
    "0xc87b56dd": encString(`data:application/json;base64,${base64}`),
    "0x42dd519c": encAddressArray([]),
  });
  const fetchJson = async () => {
    throw new Error("must not fetch a data uri");
  };
  const result = await loadAgent({ agentId: 8, rpc, fetchJson });
  assert.equal(result.status, "ok");
  assert.equal(result.registration.name, "Sealed");

  const plain = await loadAgent({
    agentId: 9,
    rpc: fakeRpc({ "0x6352211e": addr(OWNER), "0xc87b56dd": encString("data:application/json,%7B%22name%22%3A%22Plain%22%7D"), "0x42dd519c": encAddressArray([]) }),
    fetchJson,
  });
  assert.equal(plain.registration.name, "Plain");
});

test("A3 a missing agent is empty, a failed call or file is an error, and nothing throws", async () => {
  const reverted = await loadAgent({ agentId: 10, rpc: fakeRpc({ "0x6352211e": Object.assign(new Error("execution reverted"), { code: 3 }) }), fetchJson: async () => ({}) });
  assert.equal(reverted.status, "empty");
  assert.match(reverted.error, /no agent 10/);

  const zero = await loadAgent({ agentId: 11, rpc: fakeRpc({ "0x6352211e": addr("0x0000000000000000000000000000000000000000") }), fetchJson: async () => ({}) });
  assert.equal(zero.status, "empty");

  const down = await loadAgent({ agentId: 12, rpc: fakeRpc({ "0x6352211e": Object.assign(new Error("connect ECONNREFUSED"), { code: -32000 }) }), fetchJson: async () => ({}) });
  assert.equal(down.status, "error");
  assert.match(down.error, /ECONNREFUSED/);

  const badFile = await loadAgent({
    agentId: 13,
    rpc: fakeRpc({ "0x6352211e": addr(OWNER), "0xc87b56dd": encString("ipfs://bafy/missing.json"), "0x42dd519c": encAddressArray([]) }),
    fetchJson: async () => {
      throw new Error("404 Not Found");
    },
  });
  assert.equal(badFile.status, "error");
  assert.match(badFile.error, /registration file could not be read/);

  const junk = await loadAgent({ agentId: "abc", rpc: fakeRpc({}), fetchJson: async () => ({}) });
  assert.equal(junk.status, "error");
  const noRpc = await loadAgent({ agentId: 1 });
  assert.equal(noRpc.status, "error");
});

test("A4 reputation entries are read and summarised, and an agent without feedback says so", async () => {
  const clients = [OWNER, "0x2222222222222222222222222222222222222222"];
  const feedbackHex = encFeedback({
    clients,
    values: [90, 80],
    decimals: [0, 0],
    tags1: ["quality", "speed"],
    tags2: ["latency", ""],
    revoked: [false, false],
  });
  const rpc = fakeRpc({
    "0x6352211e": addr(OWNER),
    "0xc87b56dd": encString("data:application/json,%7B%22name%22%3A%22Rep%22%7D"),
    "0x42dd519c": encAddressArray(clients),
    "0xd9d84224": feedbackHex,
  });
  const result = await loadAgent({ agentId: 20, rpc, fetchJson: async () => ({}) });
  assert.equal(result.status, "ok");
  assert.equal(result.feedback.count, 2);
  assert.equal(result.feedback.average, 85);
  assert.equal(result.feedback.items[0].client, OWNER);
  assert.deepEqual(result.feedback.items[0].tags, ["quality", "latency"]);
  assert.deepEqual(result.feedback.items[1].tags, ["speed"]);

  const quiet = await loadAgent({
    agentId: 21,
    rpc: fakeRpc({ "0x6352211e": addr(OWNER), "0xc87b56dd": encString("data:application/json,%7B%22name%22%3A%22Quiet%22%7D"), "0x42dd519c": encAddressArray([]) }),
    fetchJson: async () => ({}),
  });
  assert.deepEqual(quiet.feedback, { count: 0, average: 0, items: [] });

  const withoutRegistry = await loadAgent({
    agentId: 22,
    reputationRegistry: null,
    rpc: fakeRpc({ "0x6352211e": addr(OWNER), "0xc87b56dd": encString("data:application/json,%7B%22name%22%3A%22Solo%22%7D") }),
    fetchJson: async () => ({}),
  });
  assert.deepEqual(withoutRegistry.feedback, { count: 0, average: 0, items: [] });
});

test("A5 both networks resolve their own registries, and Base Sepolia reads a live agent", async () => {
  const sepolia = await loadAgent({
    agentId: 0,
    network: "base-sepolia",
    rpc: fakeRpc({ "0x6352211e": addr(OWNER), "0xc87b56dd": encString("data:application/json,%7B%22name%22%3A%22Sepolia%22%7D"), "0x42dd519c": encAddressArray([]) }),
    fetchJson: async () => ({}),
  });
  assert.equal(sepolia.identityRegistry, REGISTRIES["base-sepolia"].identity);
  assert.equal(sepolia.reputationRegistry, REGISTRIES["base-sepolia"].reputation);
  assert.equal(sepolia.status, "ok");

  // live read: agent 0 exists on Base Sepolia and its tokenURI is a data uri, so this needs no file host
  const live = async (method, params) => {
    const response = await fetch("https://base-sepolia-rpc.publicnode.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.json();
    if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
    return body.result;
  };
  try {
    const agent = await loadAgent({ agentId: 0, network: "base-sepolia", rpc: live, fetchJson: async (url) => (await fetch(url)).json() });
    assert.equal(agent.status, "ok");
    assert.match(agent.owner, /^0x[0-9a-f]{40}$/);
    assert.ok(agent.registration && typeof agent.registration === "object");
  } catch (error) {
    assert.fail("the live Base Sepolia read failed: " + error.message);
  }
});

test("A6 the page is mobile first, light and dark", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
  assert.match(html, /prefers-color-scheme/);
  assert.match(html, /max-width/);
  assert.match(html, /@media/);
  assert.match(html, /viewer\.js/);
});

test("the decoders handle empty and revoked feedback", () => {
  assert.equal(decodeString(encString("hello")), "hello");
  const empty = encFeedback({ clients: [], values: [], decimals: [], tags1: [], tags2: [], revoked: [] });
  assert.deepEqual(decodeFeedback(empty), []);
});
