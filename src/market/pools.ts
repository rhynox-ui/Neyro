import { withRpcFallback } from "../near/rpc.js";
import { defaultStateStore, type StateStore } from "../state/store.js";
import { DCL_CONTRACT } from "./dcl.js";

/** RHEA classic (v1/v2 AMM) exchange. */
export const REF_V2_CONTRACT = "v2.ref-finance.near";

/** A two-token RHEA pool containing some token. */
export type PoolRef =
  | { kind: "v2"; id: number; tokens: [string, string] }
  | { kind: "dcl"; id: string; tokens: [string, string] };

/**
 * token -> pools it trades in, built by scanning both RHEA exchanges.
 * Pools are only ever appended, so `scanned` lets each refresh read just the
 * new ones. Reserves are not stored; callers read the pool live.
 */
export type PoolIndex = {
  v2Scanned: number;
  dclScanned: number;
  updatedAtMs: number;
  /** Compact refs: "v2:<id>:<a>|<b>" or "dcl:<token_x>|<token_y>|<fee>". */
  byToken: Record<string, string[]>;
};

const GLOBAL = 0;
const INDEX_KEY = "poolindex";
const INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const V2_PAGE = 250;
const DCL_PAGE = 100;
/** Bounds RPC calls per refresh; a first full scan finishes over a few cron runs. */
const MAX_PAGES_PER_REFRESH = 12;

const emptyIndex = (): PoolIndex => ({ v2Scanned: 0, dclScanned: 0, updatedAtMs: 0, byToken: {} });

export function encodePool(pool: PoolRef): string {
  return pool.kind === "v2" ? `v2:${pool.id}:${pool.tokens.join("|")}` : `dcl:${pool.id}`;
}

export function decodePool(ref: string): PoolRef | null {
  const v2 = /^v2:(\d+):([^|]+)\|([^|]+)$/.exec(ref);
  if (v2) return { kind: "v2", id: Number(v2[1]), tokens: [v2[2]!, v2[3]!] };
  const dcl = /^dcl:(([^|]+)\|([^|]+)\|\d+)$/.exec(ref);
  if (dcl) return { kind: "dcl", id: dcl[1]!, tokens: [dcl[2]!, dcl[3]!] };
  return null;
}

function add(index: PoolIndex, pool: PoolRef): void {
  const ref = encodePool(pool);
  for (const token of pool.tokens) {
    const list = (index.byToken[token] ??= []);
    if (!list.includes(ref)) list.push(ref);
  }
}

type Json = Record<string, unknown>;

/** Simple (constant-product, two-token) pools from v2 `get_pools`; others can't be priced by ratio. */
export function parseV2Pools(raw: unknown, fromIndex: number): PoolRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((pool: Json, i): PoolRef[] => {
    const tokens = pool?.token_account_ids;
    if (pool?.pool_kind !== "SIMPLE_POOL" || !Array.isArray(tokens) || tokens.length !== 2) return [];
    return [{ kind: "v2", id: fromIndex + i, tokens: [String(tokens[0]), String(tokens[1])] }];
  });
}

/** DCL `list_pools` entries; the id is `token_x|token_y|fee`. */
export function parseDclPools(raw: unknown): PoolRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((pool: Json): PoolRef[] => {
    const x = pool?.token_x;
    const y = pool?.token_y;
    if (typeof x !== "string" || typeof y !== "string") return [];
    const id = typeof pool.pool_id === "string" ? pool.pool_id : `${x}|${y}|${String(pool.fee)}`;
    return [{ kind: "dcl", id, tokens: [x, y] }];
  });
}

const view = (contractId: string, method: string, args: Json) =>
  withRpcFallback((provider) => provider.callFunction({ contractId, method, args }));

let memory: PoolIndex | undefined;

export async function loadPoolIndex(store: StateStore = defaultStateStore()): Promise<PoolIndex> {
  memory ??= (await store.get<PoolIndex>(GLOBAL, INDEX_KEY).catch(() => null)) ?? undefined;
  return memory ?? emptyIndex();
}

/**
 * Reads pools created since the last refresh (from both exchanges) and saves
 * the index. Run from the per-minute cron; cheap once caught up.
 */
export async function refreshPoolIndex(store: StateStore = defaultStateStore()): Promise<PoolIndex> {
  memory = undefined;
  const index = await loadPoolIndex(store);
  let pages = 0;
  let changed = false;

  while (pages < MAX_PAGES_PER_REFRESH) {
    const raw = await view(REF_V2_CONTRACT, "get_pools", { from_index: index.v2Scanned, limit: V2_PAGE });
    pages++;
    const count = Array.isArray(raw) ? raw.length : 0;
    for (const pool of parseV2Pools(raw, index.v2Scanned)) add(index, pool);
    index.v2Scanned += count;
    changed ||= count > 0;
    if (count < V2_PAGE) break;
  }
  while (pages < MAX_PAGES_PER_REFRESH) {
    const raw = await view(DCL_CONTRACT, "list_pools", { from_index: index.dclScanned, limit: DCL_PAGE });
    pages++;
    const count = Array.isArray(raw) ? raw.length : 0;
    const before = Object.keys(index.byToken).length;
    for (const pool of parseDclPools(raw)) add(index, pool);
    // RHEA's own SDK calls list_pools without paging; if the contract ignores
    // the arguments and returns every pool, that list is complete.
    if (count > DCL_PAGE) {
      changed ||= Object.keys(index.byToken).length !== before || index.dclScanned !== count;
      index.dclScanned = count;
      break;
    }
    index.dclScanned += count;
    changed ||= count > 0;
    if (count < DCL_PAGE) break;
  }

  index.updatedAtMs = Date.now();
  if (changed) await store.set(GLOBAL, INDEX_KEY, index, INDEX_TTL_MS);
  memory = index;
  return index;
}

/** Every indexed two-token pool containing `token`. */
export async function poolsForToken(token: string, store?: StateStore): Promise<PoolRef[]> {
  const refs = (await loadPoolIndex(store)).byToken[token] ?? [];
  return refs.map(decodePool).filter((pool): pool is PoolRef => pool !== null);
}

/** Live reserves of a classic simple pool, in the order of `tokens`. */
export async function fetchV2Reserves(id: number): Promise<{ tokens: string[]; amounts: bigint[] } | null> {
  const raw = (await view(REF_V2_CONTRACT, "get_pool", { pool_id: id })) as Json | null;
  const tokens = raw?.token_account_ids;
  const amounts = raw?.amounts;
  if (!Array.isArray(tokens) || !Array.isArray(amounts) || tokens.length !== amounts.length) return null;
  if (!amounts.every((a) => typeof a === "string" && /^\d+$/.test(a))) return null;
  return { tokens: tokens.map(String), amounts: amounts.map((a) => BigInt(a as string)) };
}
