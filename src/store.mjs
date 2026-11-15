import fs from "node:fs";
import path from "node:path";
import { busiestCreators, repeatedGroups, sameNameOrTicker } from "./match.mjs";

const MAX_LAUNCHES = 2000;
const MAX_MIGRATIONS = 200;
const MAX_ALERTS = 100;

export function createStore(file) {
  const state = {
    launches: [],
    migrations: [],
    guards: [],
    deployers: [],
    alerts: [],
    feed: { connected: false, error: null, lastMessage: null },
  };

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      state.launches = Array.isArray(parsed.launches) ? parsed.launches.slice(0, MAX_LAUNCHES) : [];
      state.migrations = Array.isArray(parsed.migrations) ? parsed.migrations.slice(0, MAX_MIGRATIONS) : [];
      state.guards = Array.isArray(parsed.guards) ? parsed.guards : [];
      state.deployers = Array.isArray(parsed.deployers) ? parsed.deployers : [];
      state.alerts = Array.isArray(parsed.alerts) ? parsed.alerts.slice(0, MAX_ALERTS) : [];
    } catch (error) {
      if (error.code !== "ENOENT") state.feed.error = `Could not read saved state: ${error.message}`;
    }
    const hidden = new Set(state.launches.filter((launch) => launch.mayhem).map((launch) => launch.mint));
    if (hidden.size) {
      state.launches = state.launches.filter((launch) => !hidden.has(launch.mint));
      state.migrations = state.migrations.filter((migration) => !hidden.has(migration.mint));
      state.alerts = state.alerts.filter((alert) => !hidden.has(alert.mint));
      saveSoon();
    }
  }

  let saveTimer = null;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = JSON.stringify({
        launches: state.launches,
        migrations: state.migrations,
        guards: state.guards,
        deployers: state.deployers,
        alerts: state.alerts,
      });
      fs.writeFileSync(file, body);
    }, 400);
  }

  function pushAlert(alert) {
    const key = `${alert.kind}:${alert.mint}`;
    if (state.alerts.some((item) => `${item.kind}:${item.mint}` === key)) return;
    state.alerts.unshift({ id: crypto.randomUUID(), at: Date.now(), ...alert });
    state.alerts = state.alerts.slice(0, MAX_ALERTS);
  }

  function considerLaunch(launch) {
    for (const guard of state.guards) {
      if (guard.officialMints.includes(launch.mint)) continue;
      const hit = guard.terms.find((term) => sameNameOrTicker(term.raw, launch.name, launch.symbol));
      if (hit) {
        pushAlert({
          kind: "copy",
          mint: launch.mint,
          name: launch.name,
          symbol: launch.symbol,
          creator: launch.creator,
          detail: `Name or ticker matches ${hit.raw}`,
        });
      }
    }
    for (const deployer of state.deployers) {
      if (deployer.address === launch.creator) {
        pushAlert({
          kind: "deployer",
          mint: launch.mint,
          name: launch.name,
          symbol: launch.symbol,
          creator: launch.creator,
          detail: "Watched deployer launched again",
        });
      }
    }
  }

  load();

  return {
    file,
    setFeed(patch) {
      state.feed = { ...state.feed, ...patch };
    },
    dropMint(mint) {
      state.launches = state.launches.filter((launch) => launch.mint !== mint);
      state.migrations = state.migrations.filter((migration) => migration.mint !== mint);
      state.alerts = state.alerts.filter((alert) => alert.mint !== mint);
      saveSoon();
    },
    addLaunch(event) {
      if (!event?.mint || event.is_mayhem_mode || event.mayhem) return null;
      if (state.launches.some((item) => item.mint === event.mint)) return null;
      const launch = {
        mint: event.mint,
        name: event.name || "",
        symbol: event.symbol || "",
        creator: event.traderPublicKey || event.creator || "",
        signature: event.signature || "",
        uri: event.uri || "",
        bondingCurve: event.bondingCurveKey || "",
        mayhem: Boolean(event.is_mayhem_mode),
        pool: event.pool || "pump",
        marketCapSol: event.marketCapSol ?? null,
        solAmount: event.solAmount ?? null,
        at: Date.now(),
        graduated: false,
      };
      state.launches.unshift(launch);
      state.launches = state.launches.slice(0, MAX_LAUNCHES);
      considerLaunch(launch);
      saveSoon();
      return launch;
    },
    addMigration(event) {
      if (!event?.mint || event.mayhem) {
        if (event?.mint && event.mayhem) {
          state.launches = state.launches.filter((launch) => launch.mint !== event.mint);
          state.migrations = state.migrations.filter((migration) => migration.mint !== event.mint);
          state.alerts = state.alerts.filter((alert) => alert.mint !== event.mint);
          saveSoon();
        }
        return null;
      }
      const existing = state.migrations.find((item) => item.signature && item.signature === event.signature);
      if (existing) {
        existing.name = existing.name || event.name || "";
        existing.symbol = existing.symbol || event.symbol || "";
        existing.creator = existing.creator || event.creator || "";
        saveSoon();
        return existing;
      }
      const known = state.launches.find((item) => item.mint === event.mint);
      if (known) known.graduated = true;
      const migration = {
        mint: event.mint,
        signature: event.signature || "",
        pool: event.pool || "",
        name: event.name || known?.name || "",
        symbol: event.symbol || known?.symbol || "",
        creator: event.creator || known?.creator || "",
        at: Date.now(),
      };
      state.migrations.unshift(migration);
      state.migrations = state.migrations.slice(0, MAX_MIGRATIONS);
      const watchedCreator = state.deployers.some((item) => item.address === migration.creator);
      const watchedMint = state.guards.some((guard) => guard.officialMints.includes(migration.mint)
        || guard.terms.some((term) => sameNameOrTicker(term.raw, migration.name, migration.symbol)));
      if (watchedCreator || watchedMint) {
        pushAlert({
          kind: "graduation",
          mint: migration.mint,
          name: migration.name,
          symbol: migration.symbol,
          creator: migration.creator,
          detail: `Graduated to ${migration.pool || "a pool"}`,
        });
      }
      saveSoon();
      return migration;
    },
    addGuard(guard) {
      state.guards.unshift(guard);
      saveSoon();
    },
    removeGuard(id) {
      state.guards = state.guards.filter((guard) => guard.id !== id);
      saveSoon();
    },
    addDeployer(deployer) {
      if (state.deployers.some((item) => item.address === deployer.address)) return;
      state.deployers.unshift(deployer);
      saveSoon();
    },
    removeDeployer(id) {
      state.deployers = state.deployers.filter((item) => item.id !== id);
      saveSoon();
    },
    launchesMatching(terms) {
      return state.launches.filter((launch) => terms.some((term) => sameNameOrTicker(term.raw, launch.name, launch.symbol)));
    },
    launchesByCreator(address) {
      return state.launches.filter((launch) => launch.creator === address);
    },
    findLaunch(mint) {
      return state.launches.find((launch) => launch.mint === mint) || null;
    },
    snapshot() {
      const repeated = repeatedGroups(state.launches).slice(0, 8).map((group) => ({
        term: group.term,
        count: group.launches.length,
        launches: group.launches.slice(0, 5).map(publicLaunch),
      }));
      return {
        feed: state.feed,
        counts: {
          launches: state.launches.length,
          migrations: state.migrations.length,
          guards: state.guards.length,
          deployers: state.deployers.length,
        },
        launches: state.launches.slice(0, 40).map(publicLaunch),
        migrations: state.migrations.slice(0, 20),
        guards: state.guards,
        deployers: state.deployers,
        alerts: state.alerts.slice(0, 30),
        repeated,
        busiest: busiestCreators(state.launches),
      };
    },
  };
}

function publicLaunch(launch) {
  return {
    mint: launch.mint,
    name: launch.name,
    symbol: launch.symbol,
    creator: launch.creator,
    signature: launch.signature,
    mayhem: launch.mayhem,
    pool: launch.pool,
    marketCapSol: launch.marketCapSol,
    solAmount: launch.solAmount,
    at: launch.at,
    graduated: launch.graduated,
  };
}
