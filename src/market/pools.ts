import { withRpcFallback } from "../near/rpc.js";
import { defaultStateStore, type StateStore } from "../state/store.js";
import { DCL_CONTRACT } from "./dcl.js";
import { neon } from "@neondatabase/serverless";
import { config } from "../config.js";

/** RHEA classic (v1/v2 AMM) exchange. */
export const REF_V2_CONTRACT = "v2.ref-finance.near";

/** A two-token RHEA pool containing some token. */
export type PoolRef =
  | { kind: "v2"; id: number; tokens: [string, string] }
  | { kind: "dcl"; id: string; tokens: [string, string] };

/** How far each exchange has been scanned. Pools are only ever appended. */
export type PoolCursor = { v2Scanned: number; dclScanned: number; updatedAtMs: number };

/**
 * token -> pool refs. Postgres keeps one row per (token, pool) so a lookup
 * reads a few rows instead of parsing an index of every RHEA pool, which
 * would cost too much CPU per request on Workers.
 */
export interface PoolStore {
  add(pools: readonly PoolRef[]): Promise<void>;
  forToken(token: string): Promise<string[]>;
  count(): Promise<number>;
}

export class InMemoryPoolStore implements PoolStore {
  private readonly byToken = new Map<string, Set<string>>();
  async add(pools: readonly PoolRef[]) {
    for (const pool of pools) {
      const ref = encodePool(pool);
      for (const token of pool.tokens) {
        let refs = this.byToken.get(token);
        if (!refs) this.byToken.set(token, (refs = new Set()));
        refs.add(ref);
      }
    }
  }
  async forToken(token: string) { return [...(this.byToken.get(token) ?? [])]; }
  async count() { return [...this.byToken.values()].reduce((n, refs) => n + refs.size, 0); }
}

export class PostgresPoolStore implements PoolStore {
  private readonly sql: ReturnType<typeof neon>;
  private ready: Promise<unknown> | undefined;
  constructor(databaseUrl: string) { this.sql = neon(databaseUrl); }

  /** Created on first use, so no manual migration is needed. */
  private ensure() {
    this.ready ??= this.sql`create table if not exists rhea_pools (
      token text not null,
      ref text not null,
      primary key (token, ref)
    )`.catch((error) => { this.ready = undefined; throw error; });
    return this.ready;
  }
  async add(pools: readonly PoolRef[]) {
    if (!pools.length) return;
    await this.ensure();
    const tokens: string[] = [];
    const refs: string[] = [];
    for (const pool of pools) {
      for (const token of pool.tokens) { tokens.push(token); refs.push(encodePool(pool)); }
    }
    await this.sql`insert into rhea_pools (token, ref)
      select * from unnest(${tokens}::text[], ${refs}::text[]) on conflict do nothing`;
  }
  async forToken(token: string) {
    await this.ensure();
    const rows = (await this.sql`select ref from rhea_pools where token=${token} limit 200`) as unknown as { ref: string }[];
    return rows.map((row) => row.ref);
  }
  async count() {
    await this.ensure();
    const rows = (await this.sql`select count(*)::int as n from rhea_pools`) as unknown as { n: number }[];
    return rows[0]?.n ?? 0;
  }
}

let sharedPools: PoolStore | undefined;
export function defaultPoolStore(): PoolStore {
  sharedPools ??= config.DATABASE_URL ? new PostgresPoolStore(config.DATABASE_URL) : new InMemoryPoolStore();
  return sharedPools;
}

const GLOBAL = 0;
const CURSOR_KEY = "poolindex:cursor";
const CURSOR_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const V2_PAGE = 250;
const DCL_PAGE = 100;
/** Bounds RPC calls per refresh; a first full scan finishes over a few cron runs. */
const MAX_PAGES_PER_REFRESH = 12;

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

export async function loadPoolCursor(store: StateStore = defaultStateStore()): Promise<PoolCursor> {
  return (await store.get<PoolCursor>(GLOBAL, CURSOR_KEY).catch(() => null)) ?? { v2Scanned: 0, dclScanned: 0, updatedAtMs: 0 };
}

/**
 * Indexes pools created since the last refresh on both exchanges. Run from
 * the per-minute cron; one or two RPC calls once caught up.
 */
export async function refreshPoolIndex(
  store: StateStore = defaultStateStore(),
  pools: PoolStore = defaultPoolStore()
): Promise<PoolCursor> {
  const cursor = await loadPoolCursor(store);
  if (cursor.v2Scanned === 0) await store.delete(GLOBAL, "poolindex").catch(() => {}); // pre-table index blob
  let pages = 0;

  while (pages < MAX_PAGES_PER_REFRESH) {
    const raw = await view(REF_V2_CONTRACT, "get_pools", { from_index: cursor.v2Scanned, limit: V2_PAGE });
    pages++;
    const count = Array.isArray(raw) ? raw.length : 0;
    await pools.add(parseV2Pools(raw, cursor.v2Scanned));
    cursor.v2Scanned += count;
    if (count < V2_PAGE) break;
  }
  while (pages < MAX_PAGES_PER_REFRESH) {
    const raw = await view(DCL_CONTRACT, "list_pools", { from_index: cursor.dclScanned, limit: DCL_PAGE });
    pages++;
    const count = Array.isArray(raw) ? raw.length : 0;
    await pools.add(parseDclPools(raw));
    // RHEA's own SDK calls list_pools without paging; if the contract ignores
    // the arguments and returns every pool, that list is complete.
    if (count > DCL_PAGE) {
      cursor.dclScanned = count;
      break;
    }
    cursor.dclScanned += count;
    if (count < DCL_PAGE) break;
  }

  cursor.updatedAtMs = Date.now();
  await store.set(GLOBAL, CURSOR_KEY, cursor, CURSOR_TTL_MS);
  return cursor;
}

/** Every indexed two-token pool containing `token`. */
export async function poolsForToken(token: string, pools: PoolStore = defaultPoolStore()): Promise<PoolRef[]> {
  const refs = await pools.forToken(token);
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
