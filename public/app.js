const $ = (id) => document.getElementById(id);
const WATCH_KEY = "folio-watches";
const PROJECT_CA = "";
const PUMP_SUPPLY = 1_000_000_000;

document.addEventListener("click", (event) => {
  const link = event.target.closest("a.blank");
  if (link) event.preventDefault();
});

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function usd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: amount >= 1000 ? "compact" : "standard",
    maximumFractionDigits: amount >= 1000 ? 2 : 0,
  }).format(amount);
}

function amount(value, digits = 2) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value);
}

let projectCheckedAt = "";

function paintProjectStamp() {
  const node = $("project-updated");
  if (!node || !projectCheckedAt) return;
  const slot = $("slot")?.textContent;
  node.textContent = slot && slot !== "…"
    ? `Updated ${projectCheckedAt} · Slot ${slot}`
    : `Updated ${projectCheckedAt}`;
}

function short(value) {
  if (!value) return "";
  return value.length < 14 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function ago(value) {
  const at = Number(value);
  if (!Number.isFinite(at) || at <= 0) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function agoNode(value) {
  const node = el("span", ago(value), "quiet mono stamp");
  const at = Number(value);
  if (Number.isFinite(at) && at > 0) node.dataset.at = String(Math.round(at));
  return node;
}

function paintAgo() {
  document.querySelectorAll(".stamp[data-at]").forEach((node) => {
    node.textContent = ago(node.dataset.at);
  });
}

function age(at) {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function mintButton(mint, label) {
  const button = el("button", label || short(mint), "link mono");
  button.type = "button";
  button.title = mint;
  button.addEventListener("click", () => inspect(mint));
  return button;
}

function withProjectCa(extra) {
  const parts = String(extra || "").split(",").map((part) => part.trim()).filter(Boolean);
  if (PROJECT_CA && !parts.includes(PROJECT_CA)) parts.unshift(PROJECT_CA);
  return parts.join(",");
}

function reads() {
  try {
    return JSON.parse(localStorage.getItem(WATCH_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveReads(items) {
  localStorage.setItem(WATCH_KEY, JSON.stringify(items.slice(0, 20)));
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function field(list, label, value) {
  list.append(el("dt", label));
  const dd = document.createElement("dd");
  if (value instanceof Node) dd.append(value);
  else dd.textContent = value == null || value === "" ? "—" : String(value);
  list.append(dd);
}

async function inspect(value) {
  $("value").value = value;
  $("inspect-error").textContent = "Reading…";
  $("inspect-out").replaceChildren();
  location.hash = "inspect";
  try {
    const report = await post("/api/inspect", { value });
    $("inspect-error").textContent = "";
    if (report.kind === "mayhem") return;
    renderInspect(report);
  } catch (error) {
    $("inspect-error").textContent = error.message;
  }
}

function renderInspect(report) {
  const list = document.createElement("dl");
  list.className = "receipt";
  const add = (label, value) => field(list, label, value);
  if (report.kind === "mint") {
    add("Kind", "Token CA");
    add("Name", report.name);
    add("Ticker", report.symbol);
    add("CA", report.mint);
    add("Supply", report.supplyUi);
    add("Decimals", report.decimals);
    add("CA authority", report.mintAuthority || "none");
    add("Freeze authority", report.freezeAuthority || "none");
    const curve = report.bondingCurve || {};
    add("Bonding curve", curve.address);
    add("Phase", curve.present === false ? "no curve account" : curve.complete ? "graduated" : "bonding curve");
    add("Progress", curve.progressPct == null ? "not the standard curve" : `${curve.progressPct}%`);
    add("Creator", curve.creator || "—");
    add("Creator balance", report.creatorBalance?.amount ?? report.creatorBalance?.error ?? "—");
    if (report.metadata?.description) add("Description", report.metadata.description);
    if (report.seen?.signature) add("Create", mintButton(report.seen.signature, short(report.seen.signature)));
    const pairs = report.market?.pairs || [];
    add("Pools seen", pairs.length ? pairs.map((pair) => `${pair.dexId} ${pair.quote}`).join(" · ") : "none");
  } else if (report.kind === "wallet") {
    add("Kind", "Wallet");
    add("Address", report.address);
    add("SOL", report.sol);
    add("Signatures scanned", report.scannedSignatures);
    add("Creates in that scan", report.recentCreates?.length || 0);
  } else if (report.kind === "bondingCurve") {
    add("Kind", "Bonding curve");
    add("Address", report.address);
    add("Phase", report.curve.complete ? "graduated" : "bonding curve");
    add("Creator", report.curve.creator);
  } else if (report.kind === "transaction") {
    add("Kind", "Transaction");
    add("Signature", report.signature);
    add("Slot", report.slot);
    add("Result", report.err ? "failed" : "success");
    add("Fee lamports", report.feeLamports);
    add("Signer", report.signer);
    add("Pump instructions", report.pumpInstructions.join(", ") || "none");
  }
  const root = $("inspect-out");
  root.replaceChildren(list);
  if (report.kind === "wallet" && report.recentCreates?.length) {
    root.append(el("h3", "Creates in the recent scan"));
    root.append(table(
      ["Name", "Ticker", "CA"],
      report.recentCreates.map((item) => [item.name, item.symbol, mintButton(item.mint)]),
    ));
  }
  if (report.kind === "transaction" && report.tokenChanges?.length) {
    root.append(el("h3", "Token balance changes"));
    root.append(table(
      ["CA", "Owner", "Raw delta"],
      report.tokenChanges.map((change) => [mintButton(change.mint), short(change.owner), change.deltaRaw]),
    ));
  }
}

function table(headers, rows) {
  const tableNode = document.createElement("table");
  const head = document.createElement("tr");
  headers.forEach((header) => head.append(el("th", header)));
  tableNode.append(head);
  rows.forEach((cells) => {
    const row = document.createElement("tr");
    cells.forEach((cell) => {
      const td = document.createElement("td");
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell ?? "";
      row.append(td);
    });
    tableNode.append(row);
  });
  return tableNode;
}

function renderWatches() {
  const list = $("watches");
  const items = reads();
  list.replaceChildren();
  if (!items.length) {
    list.append(el("li", "No watched addresses yet."));
    return;
  }
  items.forEach((item) => {
    const row = document.createElement("li");
    const text = el("span", `${item.label} · ${item.sol == null ? "not read" : `${item.sol} SOL`}`);
    row.append(mintButton(item.address, item.label), text);
    const remove = el("button", "Remove", "link");
    remove.type = "button";
    remove.addEventListener("click", () => {
      saveReads(reads().filter((entry) => entry.address !== item.address));
      renderWatches();
    });
    row.append(remove);
    list.append(row);
  });
}

function renderState(state) {
  const feedLive = Boolean(state.feed?.connected);
  $("slot").textContent = state.slot?.slot ?? "unavailable";
  $("feed").replaceChildren(el("span", "", feedLive ? "dot live" : "dot"), document.createTextNode(feedLive ? "live" : "reconnecting"));
  $("checked").textContent = new Date().toLocaleTimeString();

  const repeated = $("repeated");
  repeated.replaceChildren();
  if (!state.repeated?.length) repeated.append(el("p", "No repeated name in the current record."));
  state.repeated?.slice(0, 4).forEach((group) => {
    const line = el("p");
    line.append(el("b", group.term), ` · ${group.count} CAs`);
    repeated.append(line);
  });

  const launches = $("launch-list");
  launches.replaceChildren();
  state.launches.slice(0, 12).forEach((launch) => {
    const row = document.createElement("div");
    row.className = "row launch rise";
    row.append(
      el("span", age(launch.at), "quiet mono"),
      el("span", `${launch.name || "unnamed"}  ${launch.symbol || ""}`),
      el("span", launch.graduated ? "graduated" : "curve", "quiet"),
      mintButton(launch.mint),
    );
    launches.append(row);
  });
  if (!state.launches.length) launches.append(el("p", "Waiting for the next pump.fun create."));
  $("launch-meta").textContent = `${state.counts.launches} launches in this record. Mayhem coins are omitted.`;

  const onCurve = state.launches.filter((launch) => !launch.graduated).length;
  const graduated = state.counts.migrations;
  $("phase-stats").replaceChildren();
  [
    ["On the curve", onCurve],
    ["Graduated", graduated],
    ["Launches seen", state.counts.launches],
    ["Name watches", state.counts.guards],
  ].forEach(([label, value]) => {
    const wrap = document.createElement("div");
    wrap.append(el("dt", label), el("dd", String(value)));
    $("phase-stats").append(wrap);
  });
  const phaseList = $("phase-list");
  phaseList.replaceChildren();
  state.migrations.slice(0, 6).forEach((item) => {
    const row = document.createElement("div");
    row.className = "row launch";
    row.append(el("span", age(item.at), "quiet mono"), el("span", `${item.name || "unnamed"}  ${item.symbol || ""}`), el("span", item.pool || "pool", "quiet"), mintButton(item.mint));
    phaseList.append(row);
  });
  $("phase-meta").textContent = state.migrations.length ? "" : "No graduation in this record yet.";

  const guards = $("guards");
  guards.replaceChildren();
  state.guards.forEach((guard) => {
    const row = el("p");
    row.append(`${guard.terms.map((term) => term.raw).join(", ")} `);
    const remove = el("button", "Remove", "link");
    remove.type = "button";
    remove.addEventListener("click", () => post("/api/guards/remove", { id: guard.id }).then(refresh));
    row.append(remove);
    guards.append(row);
  });

  const deployers = $("deployer-list");
  deployers.replaceChildren();
  state.deployers.forEach((deployer) => {
    const row = el("p");
    row.append(mintButton(deployer.address, deployer.address));
    const remove = el("button", "Remove", "link");
    remove.type = "button";
    remove.addEventListener("click", () => post("/api/deployers/remove", { id: deployer.id }).then(refresh));
    row.append(document.createTextNode(" "), remove);
    deployers.append(row);
  });

  $("busiest").replaceChildren(table(
    ["Creator", "Launches seen"],
    state.busiest.slice(0, 5).map((item) => [mintButton(item.creator), String(item.count)]),
  ));

  $("alerts").replaceChildren();
  if (!state.alerts.length) $("alerts").append(el("p", "None yet. Save a name or a deployer, then wait for the next match."));
  else {
    $("alerts").append(table(
      ["Age", "Kind", "Detail", "CA"],
      state.alerts.slice(0, 12).map((alert) => [age(alert.at), alert.kind, alert.detail, mintButton(alert.mint)]),
    ));
  }
}

async function refresh() {
  try {
    renderState(await fetch("/api/state").then((response) => response.json()));
    paintProjectStamp();
    paintAgo();
  } catch (error) {
    $("feed").textContent = "unavailable";
  }
}

$("inspect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  inspect($("value").value);
});

$("watch-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const label = $("watch-label").value.trim();
  const address = $("watch-address").value.trim();
  const next = reads().filter((item) => item.address !== address);
  next.unshift({ label, address, sol: null });
  saveReads(next);
  renderWatches();
  try {
    const report = await post("/api/inspect", { value: address });
    const items = reads();
    const found = items.find((item) => item.address === address);
    if (found && report.kind === "wallet") found.sol = report.sol;
    saveReads(items);
    renderWatches();
  } catch {
    // The address stays on the list even if the balance read fails.
  }
  event.target.reset();
});

$("copies-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("copies-error").textContent = "Searching…";
  try {
    const result = await post("/api/copies", { terms: $("terms").value, officialMints: withProjectCa($("official").value) });
    $("copies-error").textContent = result.dexErrors?.length ? result.dexErrors.join(" ") : "";
    $("copies-out").replaceChildren(
      el("p", `${result.copies.length} exact matches. ${result.liveScanned} launches in the live record.`),
      table(
        ["Created", "Where", "Name", "Ticker", "Mcap", "CA"],
        result.copies.map((copy) => [agoNode(copy.createdAt), copy.sources.join(" + "), copy.name, copy.symbol, usd(copy.marketCapUsd), mintButton(copy.mint)]),
      ),
    );
  } catch (error) {
    $("copies-error").textContent = error.message;
  }
});

$("save-guard").addEventListener("click", async () => {
  try {
    await post("/api/guards", { terms: $("terms").value, officialMints: withProjectCa($("official").value) });
    $("copies-form").requestSubmit();
    refresh();
  } catch (error) {
    $("copies-error").textContent = error.message;
  }
});

$("deployer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("deployer-error").textContent = "Scanning recent transactions…";
  $("deployer-out").replaceChildren();
  try {
    const result = await post("/api/deployers/scan", { address: $("deployer").value });
    $("deployer-error").textContent = result.error || "";
    $("deployer-out").replaceChildren(
      el("p", `Scanned ${result.scanned} signatures. Launches: ${result.creates.length}. Seen live from this wallet: ${result.seen.length}.`),
      table(
        ["Name", "Ticker", "CA"],
        result.creates.map((item) => [item.name, item.symbol, mintButton(item.mint)]),
      ),
    );
  } catch (error) {
    $("deployer-error").textContent = error.message;
  }
});

$("save-deployer").addEventListener("click", async () => {
  try {
    await post("/api/deployers", { address: $("deployer").value });
    $("deployer-error").textContent = "";
    refresh();
  } catch (error) {
    $("deployer-error").textContent = error.message;
  }
});

async function loadProject() {
  const solscan = $("project-solscan");
  if (!PROJECT_CA) {
    $("project-symbol").textContent = "—";
    $("project-badge").textContent = "Not set";
    $("project-ca").textContent = "";
    $("project-note").textContent = "The official CA is not set.";
    solscan.href = "#";
    solscan.classList.add("blank");
    $("project-burned").textContent = "—";
    $("project-burn-meta").textContent = "";
    $("project-copies").textContent = "No official CA yet.";
    $("project-copy-badge").textContent = "—";
    return;
  }
  $("project-ca").textContent = PROJECT_CA;
  solscan.classList.remove("blank");
  solscan.href = `https://solscan.io/token/${PROJECT_CA}`;
  if (!$("official").value) $("official").value = PROJECT_CA;
  try {
    const report = await post("/api/inspect", { value: PROJECT_CA });
    if (report.kind !== "mint") {
      $("project-badge").textContent = "Unread";
      $("project-note").textContent = "This address did not read as a token ca.";
      return;
    }
    const symbol = report.symbol || "Token";
    const name = report.name || symbol;
    $("project-symbol").textContent = symbol;
    $("project-badge").textContent = "Verified on chain";
    const minted = report.supplyUi <= PUMP_SUPPLY ? PUMP_SUPPLY : report.supplyUi;
    const remaining = report.supplyUi;
    const burned = Math.max(0, minted - remaining);
    const pct = minted ? (burned / minted) * 100 : 0;
    $("project-burned").innerHTML = "";
    $("project-burned").append(el("b", amount(burned)), ` ${symbol}`);
    $("project-burn-bar").style.width = `${Math.min(100, pct)}%`;
    $("project-burn-meta").textContent = `${amount(pct, 4)}% of supply · ${burned === 0 ? "0 burns" : "supply reduced on the mint"}`;
    const lines = $("project-supply");
    lines.replaceChildren();
    [
      ["Minted", amount(minted, 0)],
      ["Burned", amount(burned)],
      ["Remaining", amount(remaining)],
    ].forEach(([label, value]) => field(lines, label, value));
    $("project-note").textContent = "Mint account read on Solana mainnet. A read is not an audit. Check the address on Solscan and against X before you trade, and never sign anything a DM sends you.";
    projectCheckedAt = new Date(report.readAt || Date.now()).toLocaleString();
    paintProjectStamp();
    const result = await post("/api/copies", { terms: `${symbol}, ${name}`, officialMints: PROJECT_CA });
    const count = result.copies.length;
    $("project-copy-badge").textContent = count ? String(count) : "None";
    $("project-copies").textContent = count
      ? `${amount(count, 0)} pump.fun coins named ${symbol} or ${name}, out of ${amount(result.liveScanned, 0)} launches in this record.`
      : `0 pump.fun coins named ${symbol} or ${name}, out of ${amount(result.liveScanned, 0)} launches in this record. Nobody else in this record uses that name or ticker. Only the address above is the project coin.`;
    $("project-copies-meta").textContent = `Checked just now · Slot ${$("slot")?.textContent || "…"}`;
  } catch (error) {
    $("project-badge").textContent = "Unread";
    $("project-note").textContent = error.message;
  }
}

$("copy-ca").addEventListener("click", async () => {
  if (!PROJECT_CA) return;
  try {
    await navigator.clipboard.writeText(PROJECT_CA);
    $("copy-ca").textContent = "Copied";
  } catch {
    $("copy-ca").textContent = "Copy failed";
  }
});

renderWatches();
refresh();
loadProject();
setInterval(refresh, 2000);
