import assert from "node:assert/strict";
import test from "node:test";
import { bondingCurvePda, creationMintFromTransaction, decodeBondingCurve } from "./chain.mjs";
import { mergeCopies, normalizeTerm, repeatedGroups, sameNameOrTicker } from "./match.mjs";

test("name and ticker match ignores case, spaces, punctuation, and fullwidth", () => {
  assert.equal(normalizeTerm("$sntl"), "sntl");
  assert.equal(normalizeTerm("S.N.T.L"), "sntl");
  assert.equal(normalizeTerm("ＳＮＴＬ"), "sntl");
  assert.equal(normalizeTerm("Project Cortex"), "projectcortex");
  assert.equal(sameNameOrTicker("SNTL", "Sentinel", "S.N.T.L"), true);
  assert.equal(sameNameOrTicker("SNTL", "Sentinel Two", "SNTL2"), false);
});

test("repeated groups only include a term used by two mints", () => {
  const groups = repeatedGroups([
    { mint: "a", name: "PROJECT CORTEX", symbol: "XTX", at: 2 },
    { mint: "b", name: "Project Cortex", symbol: "XTX", at: 1 },
    { mint: "c", name: "Other", symbol: "SOLO", at: 3 },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].launches.length, 2);
});

test("official mint is excluded from copy results", () => {
  const copies = mergeCopies([
    { mint: "real", name: "Normie", symbol: "NORMIE", sources: ["live"] },
    { mint: "copy", name: "normie", symbol: "Normie", sources: ["dexscreener"] },
  ], ["real"]);
  assert.deepEqual(copies.map((item) => item.mint), ["copy"]);
  const capped = mergeCopies([
    { mint: "copy", name: "normie", symbol: "Normie", marketCapUsd: 1200, sources: ["live"] },
    { mint: "copy", name: "normie", symbol: "Normie", marketCapUsd: 4800, sources: ["dexscreener"] },
  ], []);
  assert.equal(capped[0].marketCapUsd, 4800);
  const timed = mergeCopies([
    { mint: "copy", name: "normie", symbol: "Normie", createdAt: 1_700_000_000_500, sources: ["live"] },
    { mint: "copy", name: "normie", symbol: "Normie", createdAt: 1_700_000_000, sources: ["dexscreener"] },
  ], []);
  assert.equal(timed[0].createdAt, 1_700_000_000_000);
});

test("bonding curve pda and account layout match a live pump coin", () => {
  assert.equal(
    bondingCurvePda("ChkskUsYYEq1yF9U8hepStX3XEHKMPFmFp6SzuHxHBAF"),
    "82U1tewsE5yjYFjz7zTtgFEqa9cgZx7AaMSc6KFHrKSX",
  );
  const decoded = decodeBondingCurve(Buffer.from(
    "17b7f83760d8ac6081efcaf103ca03003fab28f1080000008157b8a572cb02006fb22801000000000080c6a47e8d0300006f94e5201602c866492563cfbc52349ffb901b0078ed027be1db7b0d98edc8de0100000000000000000000000000000000000000000000000000000000000000000000000000000000000000969d3f0000000000f372c900000000000000ac23fc0600000000000000000000000000000000000000",
    "hex",
  ));
  assert.equal(decoded.complete, false);
  assert.equal(decoded.mayhemMode, true);
  assert.equal(decoded.creator, "8WZwQJna2Kc9212usM2GhQSknk8sec5qScsq9FU29iLV");
  assert.equal(decoded.progressPct, 0.81);
  assert.equal(decoded.tokenTotalSupply, "1000000000000000");
});

test("create detection follows the pump instruction, not an inner token-account create", () => {
  const pump = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const buy = creationMintFromTransaction({
    meta: {
      logMessages: [
        `Program ${pump} invoke [1]`,
        "Program log: Instruction: Buy",
        "Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [2]",
        "Program log: Instruction: Create",
      ],
      postTokenBalances: [{ mint: "should-not-count", uiTokenAmount: { amount: "5" } }],
    },
  });
  const create = creationMintFromTransaction({
    meta: {
      logMessages: [
        `Program ${pump} invoke [1]`,
        "Program log: Instruction: CreateV2",
        "Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]",
        "Program log: Instruction: InitializeMint2",
      ],
      postTokenBalances: [
        { mint: "quote", uiTokenAmount: { amount: "1" } },
        { mint: "newmint", uiTokenAmount: { amount: "1000000000000000" } },
      ],
    },
  });
  assert.equal(buy, null);
  assert.equal(create, "newmint");
});
