import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { sameNameOrTicker } from "./match.mjs";

export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

// Standard pump.fun curve sells 793.1M tokens (6 decimals) before migration.
const STANDARD_REAL_TOKENS = 793_100_000_000_000n;

const RPCS = [
  process.env.SOLANA_RPC,
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
].filter(Boolean);

let slotCache = { at: 0, slot: null, error: null };

function outboundSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

export function bondingCurvePda(mint) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda.toBase58();
}

export function decodeBondingCurve(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 82) return null;
  const realTokenReserves = buf.readBigUInt64LE(24);
  const complete = buf[48] === 1;
  let progressPct = null;
  if (complete) progressPct = 100;
  else if (realTokenReserves <= STANDARD_REAL_TOKENS) {
    progressPct = Number(((STANDARD_REAL_TOKENS - realTokenReserves) * 10000n) / STANDARD_REAL_TOKENS) / 100;
  }
  let creator = null;
  try {
    creator = new PublicKey(buf.subarray(49, 81)).toBase58();
  } catch {
    creator = null;
  }
  return {
    virtualTokenReserves: buf.readBigUInt64LE(8).toString(),
    virtualSolReserves: buf.readBigUInt64LE(16).toString(),
    realTokenReserves: realTokenReserves.toString(),
    realSolReserves: buf.readBigUInt64LE(32).toString(),
    tokenTotalSupply: buf.readBigUInt64LE(40).toString(),
    complete,
    creator,
    mayhemMode: buf[81] === 1,
    progressPct,
    dataBytes: buf.length,
  };
}

export function classifyInput(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) throw new Error("Paste a mint, a wallet, a transaction signature, or a pump.fun link.");
  const candidates = /^[1-9A-HJ-NP-Za-km-z]+$/.test(trimmed)
    ? [trimmed]
    : trimmed.match(/[1-9A-HJ-NP-Za-km-z]{32,88}/g) || [];
  for (const candidate of candidates) {
    let bytes;
    try {
      bytes = bs58.decode(candidate);
    } catch {
      continue;
    }
    if (bytes.length === 64) return { kind: "transaction", value: candidate };
    if (bytes.length === 32) return { kind: "address", value: candidate };
  }
  throw new Error("That is not a Solana address or transaction signature.");
}

async function rpc(method, params) {
  let lastError = new Error("Solana RPC failed");
  for (const url of RPCS) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: outboundSignal(15000),
      });
      const body = await response.json();
      if (body.error) {
        lastError = new Error(body.error.message || "RPC error");
        continue;
      }
      return body.result;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function getSlot() {
  if (Date.now() - slotCache.at < 5000) return slotCache;
  try {
    const slot = await rpc("getSlot", []);
    slotCache = { at: Date.now(), slot, error: null };
  } catch (error) {
    slotCache = { at: Date.now(), slot: slotCache.slot, error: error.message };
  }
  return slotCache;
}

function rawBytes(data) {
  if (Array.isArray(data) && data[1] === "base64") return Buffer.from(data[0], "base64");
  return null;
}

function metadataFromMint(info) {
  const extensions = info?.extensions || [];
  const metadata = extensions.find((item) => item.extension === "tokenMetadata")?.state;
  if (!metadata) return { name: "", symbol: "", uri: "" };
  return {
    name: metadata.name || "",
    symbol: metadata.symbol || "",
    uri: metadata.uri || "",
  };
}

function safeHttpUrl(uri) {
  if (!uri) return null;
  if (uri.startsWith("ipfs://")) {
    const cid = uri.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://ipfs.io/ipfs/${cid}`;
  }
  try {
    const url = new URL(uri);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function fetchMetadata(uri) {
  const url = safeHttpUrl(uri);
  if (!url) return null;
  try {
    const response = await fetch(url, { signal: outboundSignal(4000) });
    if (!response.ok) return { uri: url, error: `metadata HTTP ${response.status}` };
    const text = await response.text();
    if (text.length > 200_000) return { uri: url, error: "metadata too large" };
    const json = JSON.parse(text);
    return {
      uri: url,
      name: json.name || "",
      symbol: json.symbol || "",
      description: String(json.description || "").slice(0, 500),
      image: safeHttpUrl(json.image),
    };
  } catch (error) {
    return { uri: url, error: error.message };
  }
}

async function creatorBalance(mint, owner, tokenProgram) {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), true, tokenProgram);
    const account = await rpc("getAccountInfo", [ata.toBase58(), { encoding: "jsonParsed" }]);
    const amount = account?.value?.data?.parsed?.info?.tokenAmount;
    return {
      address: ata.toBase58(),
      amount: amount?.uiAmountString || "0",
      raw: amount?.amount || "0",
    };
  } catch (error) {
    return { error: error.message };
  }
}

async function largestAccounts(mint) {
  try {
    const result = await rpc("getTokenLargestAccounts", [mint]);
    return (result?.value || []).slice(0, 5).map((item) => ({
      address: item.address,
      amount: item.uiAmountString ?? String(item.uiAmount ?? item.amount),
      raw: item.amount,
    }));
  } catch (error) {
    return { error: error.message };
  }
}

async function dexPairs(mint) {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: outboundSignal(8000),
    });
    if (!response.ok) return { error: `Dexscreener HTTP ${response.status}`, pairs: [] };
    const body = await response.json();
    const pairs = (body.pairs || [])
      .filter((pair) => pair.chainId === "solana")
      .slice(0, 4)
      .map((pair) => ({
        dexId: pair.dexId,
        pairAddress: pair.pairAddress,
        quote: pair.quoteToken?.symbol || "",
        priceUsd: pair.priceUsd || null,
        marketCap: pair.marketCap ?? pair.fdv ?? null,
        liquidityUsd: pair.liquidity?.usd ?? null,
        url: pair.url || "",
      }));
    return { pairs };
  } catch (error) {
    return { error: error.message, pairs: [] };
  }
}

export async function inspectMint(mint) {
  let mintKey;
  try {
    mintKey = new PublicKey(mint).toBase58();
  } catch {
    throw new Error("That mint address is not valid.");
  }
  const curveAddress = bondingCurvePda(mintKey);
  const accounts = await rpc("getMultipleAccounts", [[mintKey, curveAddress], { encoding: "jsonParsed" }]);
  const mintAccount = accounts?.value?.[0];
  const curveAccount = accounts?.value?.[1];
  if (!mintAccount) throw new Error("No account at that address.");
  const parsed = mintAccount.data?.parsed;
  if (parsed?.type !== "mint") throw new Error("That address is not a token mint.");

  const info = parsed.info || {};
  const tokenProgram = mintAccount.owner;
  const programKey = tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const meta = metadataFromMint(info);
  const curveBytes = curveAccount?.owner === PUMP_PROGRAM_ID.toBase58() ? rawBytes(curveAccount.data) : null;
  const curve = curveBytes ? decodeBondingCurve(curveBytes) : null;
  if (curve?.mayhemMode) return { kind: "mayhem", mint: mintKey };
  const decimals = info.decimals ?? 0;
  const supplyRaw = info.supply || "0";
  const supplyUi = decimals ? Number(supplyRaw) / 10 ** decimals : Number(supplyRaw);

  const [metadata, holders, balance, market] = await Promise.all([
    fetchMetadata(meta.uri),
    largestAccounts(mintKey),
    curve?.creator ? creatorBalance(mintKey, curve.creator, programKey) : Promise.resolve(null),
    dexPairs(mintKey),
  ]);

  return {
    kind: "mint",
    mint: mintKey,
    tokenProgram,
    decimals,
    supplyRaw,
    supplyUi,
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
    name: meta.name,
    symbol: meta.symbol,
    uri: meta.uri,
    metadata,
    bondingCurve: curve
      ? { address: curveAddress, ...curve, owner: curveAccount.owner }
      : { address: curveAddress, present: false },
    creatorBalance: balance,
    largestAccounts: holders,
    market,
    readAt: new Date().toISOString(),
  };
}

function isPumpCurve(account) {
  if (account?.owner !== PUMP_PROGRAM_ID.toBase58()) return false;
  const bytes = rawBytes(account.data);
  return bytes ? decodeBondingCurve(bytes) : null;
}

export async function inspectAddress(address) {
  const account = await rpc("getAccountInfo", [address, { encoding: "jsonParsed" }]);
  const value = account?.value;
  if (value?.data?.parsed?.type === "mint") return inspectMint(address);
  if (value?.data?.parsed?.type === "account" && value.data.parsed.info?.mint) {
    const mintReport = await inspectMint(value.data.parsed.info.mint);
    return {
      ...mintReport,
      pastedTokenAccount: {
        address,
        owner: value.data.parsed.info.owner,
        amount: value.data.parsed.info.tokenAmount?.uiAmountString || "0",
      },
    };
  }
  const curve = value ? isPumpCurve(value) : null;
  if (curve?.mayhemMode) return { kind: "mayhem", address };
  if (curve) {
    return {
      kind: "bondingCurve",
      address,
      lamports: value.lamports,
      curve,
      readAt: new Date().toISOString(),
    };
  }
  const creates = await findRecentCreates(address, 12);
  return {
    kind: "wallet",
    address,
    lamports: value?.lamports || 0,
    sol: (value?.lamports || 0) / 1e9,
    owner: value?.owner || null,
    exists: Boolean(value),
    recentCreates: creates.creates,
    scannedSignatures: creates.scanned,
    scanError: creates.error,
    readAt: new Date().toISOString(),
  };
}

export function creationMintFromTransaction(tx) {
  const logs = tx?.meta?.logMessages || [];
  let current = null;
  let isCreate = false;
  for (const line of logs) {
    const invoke = line.match(/^Program (\S+) invoke \[/);
    if (invoke) {
      current = invoke[1];
      continue;
    }
    if (current === PUMP_PROGRAM_ID.toBase58() && /^Program log: Instruction: Create(V2)?$/.test(line)) {
      isCreate = true;
    }
  }
  if (!isCreate) return null;
  const positives = (tx.meta?.postTokenBalances || [])
    .filter((balance) => BigInt(balance.uiTokenAmount?.amount || "0") > 0n)
    .sort((a, b) => (BigInt(b.uiTokenAmount.amount) > BigInt(a.uiTokenAmount.amount) ? 1 : -1));
  return positives[0]?.mint || null;
}

async function mapPool(items, size, fn) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await fn(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, () => worker()));
  return results;
}

export async function findRecentCreates(address, limit = 12) {
  try {
    const signatures = await rpc("getSignaturesForAddress", [address, { limit }]);
    const parsed = await mapPool(signatures || [], 4, async (entry) => {
      try {
        const tx = await rpc("getTransaction", [
          entry.signature,
          { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
        ]);
        const mint = creationMintFromTransaction(tx);
        if (!mint) return null;
        const keys = tx.transaction?.message?.accountKeys || [];
        const signer = keys.find((key) => key.signer)?.pubkey || keys[0]?.pubkey || null;
        return {
          signature: entry.signature,
          mint,
          creator: signer,
          blockTime: tx.blockTime || entry.blockTime || null,
        };
      } catch {
        return null;
      }
    });
    const creates = parsed.filter(Boolean);
    if (creates.length) {
      const mints = [...new Set(creates.map((item) => item.mint))];
      const accounts = await rpc("getMultipleAccounts", [mints, { encoding: "jsonParsed" }]);
      creates.forEach((item) => {
        const info = accounts?.value?.[mints.indexOf(item.mint)]?.data?.parsed?.info;
        const meta = metadataFromMint(info);
        item.name = meta.name;
        item.symbol = meta.symbol;
      });
    }
    const hidden = await mayhemMints(creates.map((item) => item.mint));
    return { creates: creates.filter((item) => !hidden.has(item.mint)), scanned: (signatures || []).length, error: null };
  } catch (error) {
    return { creates: [], scanned: 0, error: error.message };
  }
}

export async function inspectTransaction(signature) {
  const tx = await rpc("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
  if (!tx) throw new Error("Transaction not found. It may be too old for this RPC, or not landed yet.");
  const keys = tx.transaction?.message?.accountKeys || [];
  const instructions = [];
  let current = null;
  for (const line of tx.meta?.logMessages || []) {
    const invoke = line.match(/^Program (\S+) invoke \[/);
    if (invoke) {
      current = invoke[1];
      continue;
    }
    if (current === PUMP_PROGRAM_ID.toBase58() && line.startsWith("Program log: Instruction:")) {
      instructions.push(line.replace("Program log: Instruction: ", ""));
    }
  }
  const pre = new Map((tx.meta?.preTokenBalances || []).map((balance) => [
    `${balance.accountIndex}:${balance.mint}`,
    balance,
  ]));
  const changes = [];
  for (const balance of tx.meta?.postTokenBalances || []) {
    const before = pre.get(`${balance.accountIndex}:${balance.mint}`);
    const afterRaw = BigInt(balance.uiTokenAmount?.amount || "0");
    const beforeRaw = BigInt(before?.uiTokenAmount?.amount || "0");
    if (afterRaw === beforeRaw) continue;
    changes.push({
      mint: balance.mint,
      owner: balance.owner,
      deltaRaw: (afterRaw - beforeRaw).toString(),
      decimals: balance.uiTokenAmount?.decimals ?? 0,
    });
  }
  return {
    kind: "transaction",
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime || null,
    err: tx.meta?.err || null,
    feeLamports: tx.meta?.fee ?? null,
    pumpInstructions: instructions,
    tokenChanges: changes.slice(0, 12),
    signer: keys.find((key) => key.signer)?.pubkey || null,
    loadedAddresses: keys.length,
    readAt: new Date().toISOString(),
  };
}

export async function searchDexCopies(terms) {
  const found = [];
  const errors = [];
  for (const term of terms) {
    const queries = [...new Set([term.raw, term.normalized].filter(Boolean))];
    for (const query of queries) {
      try {
        const response = await fetch(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`,
          { signal: outboundSignal(8000) },
        );
        if (!response.ok) {
          errors.push(`${query}: HTTP ${response.status}`);
          continue;
        }
        const body = await response.json();
        for (const pair of body.pairs || []) {
          if (pair.chainId !== "solana") continue;
          if (pair.dexId !== "pumpfun" && pair.dexId !== "pumpswap") continue;
          const name = pair.baseToken?.name || "";
          const symbol = pair.baseToken?.symbol || "";
          if (!sameNameOrTicker(term.raw, name, symbol)) continue;
          const marketCapUsd = Number(pair.marketCap ?? pair.fdv);
          found.push({
            mint: pair.baseToken.address,
            name,
            symbol,
            creator: null,
            dexId: pair.dexId,
            url: pair.url || "",
            marketCapUsd: Number.isFinite(marketCapUsd) ? marketCapUsd : null,
            createdAt: pair.pairCreatedAt ?? null,
            sources: ["dexscreener"],
          });
        }
      } catch (error) {
        errors.push(`${query}: ${error.message}`);
      }
    }
  }
  return { found, errors };
}

export async function marketCapsUsd(mints) {
  const unique = [...new Set(mints.filter(Boolean))].slice(0, 60);
  const caps = new Map();
  for (let index = 0; index < unique.length; index += 30) {
    const batch = unique.slice(index, index + 30);
    try {
      const response = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`,
        { signal: outboundSignal(8000) },
      );
      if (!response.ok) continue;
      const pairs = await response.json();
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        const mint = pair.baseToken?.address;
        const cap = Number(pair.marketCap ?? pair.fdv);
        if (!mint || !Number.isFinite(cap)) continue;
        const previous = caps.get(mint);
        if (previous == null || cap > previous) caps.set(mint, cap);
      }
    } catch {
      // A missing quote leaves that row blank. The name match still stands.
    }
  }
  return caps;
}

export async function mayhemMints(mints) {
  const unique = [...new Set(mints.filter(Boolean))];
  const hidden = new Set();
  if (!unique.length) return hidden;
  const curves = unique.map((mint) => bondingCurvePda(mint));
  const accounts = await rpc("getMultipleAccounts", [curves, { encoding: "base64" }]);
  unique.forEach((mint, index) => {
    const raw = accounts?.value?.[index]?.data?.[0];
    if (!raw) return;
    const curve = decodeBondingCurve(Buffer.from(raw, "base64"));
    if (curve?.mayhemMode) hidden.add(mint);
  });
  return hidden;
}

export async function readMintLabels(mint) {
  try {
    const curveAddress = bondingCurvePda(mint);
    const accounts = await rpc("getMultipleAccounts", [[mint, curveAddress], { encoding: "jsonParsed" }]);
    const meta = metadataFromMint(accounts?.value?.[0]?.data?.parsed?.info);
    const curve = decodeBondingCurve(rawBytes(accounts?.value?.[1]?.data) || Buffer.alloc(0));
    return {
      name: meta.name,
      symbol: meta.symbol,
      creator: curve?.creator || "",
      mayhem: curve?.mayhemMode === true,
    };
  } catch {
    return null;
  }
}
