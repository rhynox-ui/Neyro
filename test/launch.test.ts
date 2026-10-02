import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN ??= "test-token";

const { launchQuoteBytes } = await import("../src/launch/nearly.js");

test("NEARly launch quote bytes include icon plus name, symbol and description", () => {
  const input = {
    name: "Café",
    symbol: "CAFE",
    description: "A launch",
    icon: "https://example.com/logo.webp"
  };
  const expected = new TextEncoder().encode(
    input.name + input.symbol + input.description
  ).byteLength + new TextEncoder().encode(input.icon).byteLength;
  assert.equal(launchQuoteBytes(input), expected);
});

test("NEARly launch quote bytes handle missing optional metadata", () => {
  const input = { name: "Test", symbol: "TEST" };
  assert.equal(
    launchQuoteBytes(input),
    new TextEncoder().encode("TestTEST").byteLength
  );
});


const { applyBuyTax, applySellTax } = await import("../src/trading/tax.js");

test("NEARly buy tax reduces displayed output in base units", () => {
  assert.equal(applyBuyTax(1_000n, 100), 990n);
  assert.equal(applyBuyTax(9n, 400), 8n);
});

test("NEARly sell tax reduces the amount reaching Rhea", () => {
  assert.equal(applySellTax(1_000n, 100), 990n);
  assert.equal(applySellTax(1_000n, 400), 960n);
});
