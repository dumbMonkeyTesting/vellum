import { mayhemMints, readMintLabels } from "./chain.mjs";

const FEED_URL = "wss://pumpportal.fun/api/data";

export function createFeed(store) {
  let backoff = 1000;
  let socket = null;
  let reconnectTimer = null;
  let running = true;

  function connect() {
    if (!running) return;
    clearTimeout(reconnectTimer);
    socket = new WebSocket(FEED_URL);
    socket.addEventListener("open", () => {
      if (!running) {
        socket?.close();
        return;
      }
      backoff = 1000;
      store.setFeed({ connected: true, running: true, error: null, lastMessage: "connected" });
      socket.send(JSON.stringify({ method: "subscribeNewToken" }));
      socket.send(JSON.stringify({ method: "subscribeMigration" }));
    });
    socket.addEventListener("message", (event) => {
      if (!running) return;
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.txType === "create") {
        if (message.is_mayhem_mode) return;
        store.addLaunch(message);
        store.setFeed({ lastMessage: `create ${message.symbol || message.mint}` });
        return;
      }
      if (message.txType === "migrate") {
        fillMigration(message);
        return;
      }
      if (message.message) store.setFeed({ lastMessage: message.message });
    });
    socket.addEventListener("error", () => {
      if (running) store.setFeed({ error: "Live feed connection failed" });
    });
    socket.addEventListener("close", () => {
      store.setFeed({ connected: false, running });
      if (!running) return;
      const wait = backoff;
      backoff = Math.min(backoff * 2, 15000);
      reconnectTimer = setTimeout(connect, wait);
    });
  }

  async function fillMigration(message) {
    if (!running) return;
    const known = store.findLaunch(message.mint);
    let creator = known?.creator || message.creator || "";
    let name = known?.name || message.name || "";
    let symbol = known?.symbol || message.symbol || "";
    let mayhem = false;
    if (!name || !creator) {
      const labels = await readMintLabels(message.mint);
      if (!running) return;
      if (labels?.mayhem) mayhem = true;
      name = name || labels?.name || "";
      symbol = symbol || labels?.symbol || "";
      creator = creator || labels?.creator || "";
    }
    if (!mayhem) {
      const hidden = await mayhemMints([message.mint]);
      if (!running) return;
      mayhem = hidden.has(message.mint);
    }
    if (mayhem) {
      store.dropMint(message.mint);
      return;
    }
    store.setFeed({ lastMessage: `migrate ${symbol || message.mint}` });
    store.addMigration({ ...message, creator, name, symbol, mayhem: false });
  }

  async function sweepSavedMayhem() {
    if (!running) return;
    try {
      const hidden = await mayhemMints(store.snapshot().migrations.map((migration) => migration.mint));
      if (!running) return;
      for (const mint of hidden) store.dropMint(mint);
    } catch {
      // Stop aborts the account read.
    }
  }

  connect();
  sweepSavedMayhem();
  for (const migration of store.snapshot().migrations) {
    if (!migration.name) fillMigration(migration);
  }
}
