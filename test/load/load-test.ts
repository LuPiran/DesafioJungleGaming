/**
 * Optional load experiment. Not a pass/fail gate — records honest numbers.
 *
 * Usage (stack already running on :3000):
 *   bun run test:load
 */
export {};

const baseUrl = process.env.LOAD_BASE_URL ?? "http://127.0.0.1:3000";
const concurrency = Number(process.env.LOAD_CONCURRENCY ?? 20);
const betsPerWallet = Number(process.env.LOAD_BETS ?? 20);

async function openWallet(initial: string) {
  const playerId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount: initial, currency: "BRL" },
    }),
  });
  if (!response.ok) {
    throw new Error(`openWallet ${response.status}`);
  }
  return (await response.json()) as { id: string; playerId: string };
}

async function bet(walletId: string, playerId: string, n: number): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/wagering/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": `load:${walletId}:${n}`,
    },
    body: JSON.stringify({
      providerId: "load",
      externalTransactionId: `${walletId}:${n}`,
      playerId,
      walletId,
      roundId: `round-${n}`,
      gameId: "load",
      kind: "BET",
      money: { amount: "1.00", currency: "BRL" },
    }),
  });
  if (!response.ok) {
    throw new Error(`bet failed: ${response.status}`);
  }
  return performance.now() - started;
}

const latencies: number[] = [];
let errors = 0;
const started = performance.now();

const wallets = await Promise.all(
  Array.from({ length: concurrency }, () => openWallet("1000.00")),
);

await Promise.all(
  wallets.map(async (wallet) => {
    for (let i = 0; i < betsPerWallet; i += 1) {
      try {
        latencies.push(await bet(wallet.id, wallet.playerId, i));
      } catch {
        errors += 1;
      }
    }
  }),
);

latencies.sort((a, b) => a - b);
const percentile = (p: number) =>
  latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))] ?? 0;
const elapsed = (performance.now() - started) / 1000;
const total = latencies.length;

console.log(
  JSON.stringify(
    {
      environment: {
        baseUrl,
        concurrency,
        betsPerWallet,
        runtime: "bun",
      },
      methodology:
        "N wallets opened, then sequential 1.00 BRL BETs per wallet with unique idempotency keys. Parallelism is across wallets, not on a single hot wallet.",
      throughputRps: total > 0 ? Number((total / elapsed).toFixed(2)) : 0,
      totalRequests: total,
      errors,
      errorRate: total + errors === 0 ? 0 : errors / (total + errors),
      latencyMs: {
        p50: Number(percentile(50).toFixed(2)),
        p95: Number(percentile(95).toFixed(2)),
        p99: Number(percentile(99).toFixed(2)),
      },
    },
    null,
    2,
  ),
);
