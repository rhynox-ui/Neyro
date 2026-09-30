import { actions, type Action } from "near-api-js";

/**
 * NEAR actions in the wallet-selector JSON shape RHEA's build API returns:
 * `{ type: "FunctionCall", params: { methodName, args, gas, deposit } }`.
 * Amounts are decimal strings (gas in units, deposit in yoctoNEAR).
 */
export type WalletAction =
  | {
      type: "FunctionCall";
      params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string };
    }
  | { type: "Transfer"; params: { deposit: string } };

const DECIMAL = /^\d+$/;
const MAX_GAS = 300_000_000_000_000n; // 300 TGas protocol limit

export function functionCall(
  methodName: string,
  args: Record<string, unknown>,
  gas: bigint,
  deposit: bigint
): WalletAction {
  return { type: "FunctionCall", params: { methodName, args, gas: gas.toString(), deposit: deposit.toString() } };
}

function decimal(value: unknown, field: string): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof text !== "string" || !DECIMAL.test(text)) throw new Error(`Invalid NEAR action ${field}`);
  return text;
}

/**
 * Validates one action from an external build. Only FunctionCall and
 * Transfer are accepted: a swap never needs AddKey, DeleteKey,
 * DeleteAccount, Stake or DeployContract, and signing one of those from a
 * remote API response could hand the wallet to someone else.
 */
export function parseWalletAction(raw: unknown): WalletAction {
  if (!raw || typeof raw !== "object") throw new Error("Invalid NEAR action");
  const { type, params } = raw as { type?: unknown; params?: Record<string, unknown> };
  const kind = String(type ?? "").toLowerCase();

  if (kind === "functioncall" && params) {
    const methodName = params.methodName;
    if (
      typeof methodName !== "string" ||
      !methodName ||
      methodName.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(methodName)
    ) throw new Error("Invalid NEAR action methodName");
    let args = params.args ?? {};
    if (typeof args === "string") args = JSON.parse(args);
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid NEAR action args");
    const serializedArgs = JSON.stringify(args);
    if (serializedArgs === undefined || serializedArgs.length > 128_000) {
      throw new Error("NEAR action args are too large");
    }
    const gas = decimal(params.gas ?? "30000000000000", "gas");
    if (BigInt(gas) > MAX_GAS) throw new Error("NEAR action gas exceeds 300 TGas");
    return {
      type: "FunctionCall",
      params: { methodName, args: args as Record<string, unknown>, gas, deposit: decimal(params.deposit ?? "0", "deposit") }
    };
  }

  if (kind === "transfer" && params) {
    return { type: "Transfer", params: { deposit: decimal(params.deposit, "deposit") } };
  }

  throw new Error(`Refusing to sign NEAR action of type ${String(type)}`);
}

export function toNearApiAction(action: WalletAction): Action {
  if (action.type === "Transfer") return actions.transfer(BigInt(action.params.deposit));
  const { methodName, args, gas, deposit } = action.params;
  return actions.functionCall(methodName, args, BigInt(gas), BigInt(deposit));
}
