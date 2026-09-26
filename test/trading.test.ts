import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { TradingService } = await import("../src/trading/service.js");
const { NoopTradeRepository } = await import("../src/trading/repository.js");
const { UserFacingError } = await import("../src/errors.js");

class ClaimOnceRepository extends NoopTradeRepository {
  claims = 0;
  cancelled: string[] = [];
  override async claim() {
    this.claims++;
    return { kind: "unavailable" as const };
  }
  override async cancel(_userId: number, key: string) {
    this.cancelled.push(key);
  }
}

test("execute refuses a quote the repository will not hand out", async () => {
  const repository = new ClaimOnceRepository();
  const service = new TradingService(undefined, undefined, repository);
  await assert.rejects(service.execute(1, "0123456789abcdef"), (error) =>
    error instanceof UserFacingError && /expired or is invalid/.test(error.message)
  );
  assert.equal(repository.claims, 1);
});

test("without persistence, execute refuses unknown quotes", async () => {
  const service = new TradingService(undefined, undefined, new NoopTradeRepository());
  await assert.rejects(service.execute(1, "fedcba9876543210"), UserFacingError);
});

test("cancel is delegated to the repository", async () => {
  const repository = new ClaimOnceRepository();
  const service = new TradingService(undefined, undefined, repository);
  await service.cancel(1, "0123456789abcdef");
  assert.deepEqual(repository.cancelled, ["0123456789abcdef"]);
});
