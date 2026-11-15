import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  classifyInput,
  findRecentCreates,
  getSlot,
  inspectAddress,
  inspectTransaction,
  mayhemMints,
  marketCapsUsd,
  searchDexCopies,
} from "./chain.mjs";
import { mergeCopies, parseTerms } from "./match.mjs";
import { createStore } from "./store.mjs";
import { createFeed } from "./feed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const store = createStore(path.join(root, "data", "state.json"));
const port = Number(process.env.PORT || 8787);

const files = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/styles.css": "styles.css",
};

createFeed(store);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && files[url.pathname]) {
      const filePath = path.join(publicDir, files[url.pathname]);
      const type = filePath.endsWith(".css") ? "text/css" : filePath.endsWith(".js") ? "text/javascript" : "text/html";
      res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      const slot = await getSlot();
      return send(res, 200, { ...store.snapshot(), slot, now: Date.now() });
    }
    if (req.method === "POST" && url.pathname === "/api/inspect") {
      const body = await readJson(req);
      const target = classifyInput(body.value);
      const report = target.kind === "transaction"
        ? await inspectTransaction(target.value)
        : await inspectAddress(target.value);
      const seen = report.mint ? store.findLaunch(report.mint) : null;
      const seenByCreator = report.kind === "wallet" ? store.launchesByCreator(report.address) : [];
      return send(res, 200, { ...report, seen, seenByCreator });
    }
    if (req.method === "POST" && url.pathname === "/api/copies") {
      const body = await readJson(req);
      const terms = parseTerms(body.terms);
      if (!terms.length) return send(res, 400, { error: "Enter a name or ticker." });
      const officialMints = parseMints(body.officialMints);
      const local = store.launchesMatching(terms).map((launch) => ({
        mint: launch.mint,
        name: launch.name,
        symbol: launch.symbol,
        creator: launch.creator,
        createdAt: launch.at,
        sources: ["live"],
      }));
      const dex = await searchDexCopies(terms);
      const hidden = await mayhemMints([...local, ...dex.found].map((item) => item.mint));
      const visible = [...local, ...dex.found].filter((item) => !hidden.has(item.mint));
      const copies = mergeCopies(visible, officialMints);
      const caps = await marketCapsUsd(copies.filter((copy) => copy.marketCapUsd == null).map((copy) => copy.mint));
      for (const copy of copies) {
        if (copy.marketCapUsd == null && caps.has(copy.mint)) copy.marketCapUsd = caps.get(copy.mint);
      }
      return send(res, 200, {
        terms,
        copies,
        dexErrors: dex.errors,
        liveScanned: store.snapshot().counts.launches,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/guards") {
      const body = await readJson(req);
      const terms = parseTerms(body.terms);
      if (!terms.length) return send(res, 400, { error: "Enter a name or ticker to watch." });
      const guard = {
        id: crypto.randomUUID(),
        terms,
        officialMints: parseMints(body.officialMints),
        createdAt: Date.now(),
      };
      store.addGuard(guard);
      return send(res, 200, { guard });
    }
    if (req.method === "POST" && url.pathname === "/api/guards/remove") {
      const body = await readJson(req);
      store.removeGuard(String(body.id || ""));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/deployers") {
      const body = await readJson(req);
      const address = oneMint(body.address);
      store.addDeployer({ id: crypto.randomUUID(), address, createdAt: Date.now() });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/deployers/remove") {
      const body = await readJson(req);
      store.removeDeployer(String(body.id || ""));
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/deployers/scan") {
      const body = await readJson(req);
      const address = oneMint(body.address);
      const scanned = await findRecentCreates(address, 15);
      return send(res, 200, {
        address,
        ...scanned,
        seen: store.launchesByCreator(address),
      });
    }
    send(res, 404, { error: "Not found" });
  } catch (error) {
    send(res, 400, { error: error.message || "Request failed" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Pump Reader http://127.0.0.1:${port}`);
});

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20_000) reject(new Error("Request is too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Request body is not JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseMints(value) {
  return [...new Set(String(value ?? "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))]
    .slice(0, 8)
    .map(oneMint);
}

function oneMint(value) {
  try {
    return new PublicKey(String(value || "").trim()).toBase58();
  } catch {
    throw new Error("Enter a valid Solana address.");
  }
}
