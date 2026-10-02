

export type NearlyQuoteAsset = {
  accountId: string;
  symbol: string;
  decimals: number;
};

export const NEARLY_FACTORY = "nearlytrade.near";
export const NEARLY_WNEAR = "wrap.near";
export const NEARLY_NATIVE = "near";
export const NEARLY_LAUNCH_QUOTE_IDS = [
  "wrap.near",
  "nearly-993927.nearlytrade.near",
  "token.rhealab.near",
  "zec.omft.near",
  "kat.token0.near",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
  "eth.bridge.near"
] as const;

const KNOWN_QUOTE_SYMBOLS: Record<string, string> = {
  [NEARLY_WNEAR]: "NEAR",
  "nearly-993927.nearlytrade.near": "NEARLY",
  "token.rhealab.near": "RHEA",
  "zec.omft.near": "ZEC",
  "kat.token0.near": "KAT",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "USDC",
  "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near": "BTC",
  "eth.bridge.near": "ETH"
};

function parseQuoteAssets(raw: unknown): NearlyQuoteAsset[] {
  const root = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const source = Array.isArray(raw) ? raw
    : Array.isArray(root.quotes) ? root.quotes
    : Array.isArray(root.pairs) ? root.pairs
    : Object.entries((root.quotes ?? root.pairs ?? {}) as Record<string, unknown>)
      .map(([key, value]) => [key, value]);

  const out: NearlyQuoteAsset[] = [];
  for (const item of source as unknown[]) {
    if (Array.isArray(item) && item.length === 2 && typeof item[0] === "string") {
      const id = item[0];
      const meta = item[1] && typeof item[1] === "object" ? item[1] as Record<string, unknown> : {};
      const decimals = typeof meta.decimals === "number" ? meta.decimals : typeof meta.decimals === "string" ? Number(meta.decimals) : id === "nearly-993927.nearlytrade.near" ? 18 : 24;
      out.push({ accountId:id, symbol: typeof meta.symbol === "string" ? meta.symbol.toUpperCase() : KNOWN_QUOTE_SYMBOLS[id] ?? id.split(".")[0]!.toUpperCase(), decimals:Number.isInteger(decimals) ? decimals : 24 });
      continue;
    }
    if (typeof item === "string") {
      out.push({accountId:item,symbol:KNOWN_QUOTE_SYMBOLS[item] ?? item.split(".")[0]!.toUpperCase(),decimals:item==="nearly-993927.nearlytrade.near"?18:24});
    }
  }
  const unique = new Map(out.map(x=>[x.accountId,x]));
  return [...unique.values()].filter(x=>NEARLY_LAUNCH_QUOTE_IDS.includes(x.accountId as typeof NEARLY_LAUNCH_QUOTE_IDS[number]));
}

export async function getNearlyLaunchQuotes(rpc = new NearRpcClient()): Promise<NearlyQuoteAsset[]> {
  const raw = await rpc.viewFunction<unknown>(NEARLY_FACTORY, "get_quotes", {});
  return parseQuoteAssets(raw);
}

function yocto(value: string): bigint {
  const clean=value.trim();
  if(!/^\d+(?:\.\d{1,24})?$/.test(clean)) throw new Error("Invalid NEAR amount");
  const [whole,fraction=""]=clean.split(".");
  return BigInt(whole)*10n**24n+BigInt(fraction.padEnd(24,"0")||"0");
}

function formatNear(value: bigint): string {
  const whole=value/10n**24n;
  const fraction=(value%10n**24n).toString().padStart(24,"0").replace(/0+$/,"");
  return fraction ? whole+"."+fraction : whole.toString();
}

export type LaunchForm = {
  name:string; symbol:string; description:string; icon:string; website:string; twitter:string; telegram:string;
  quote:string; devBuyNear:string; buyBps:number; sellBps:number; creatorBps:number; burnBps:number; holdersBps:number;
};

export type LaunchCost = { launch_fee:string; token_storage:string; pool_create:string; dcl_storage:string; dev_buy:string; total:string };

function validateHttps(value:string,label:string):string {
  const v=value.trim();
  if(!v) return "";
  const url=new URL(v);
  if(url.protocol!=="https:" || url.username || url.password) throw new Error(label+" must be an HTTPS URL");
  if(v.length>200) throw new Error(label+" is too long");
  return v;
}

function validateIcon(icon:string):string {
  const v=icon.trim();
  if(!v) return "";
  if(!(v.startsWith("https://") || v.startsWith("ipfs://") || v.startsWith("data:image/"))) throw new Error("Logo must be an HTTPS, IPFS, or uploaded image");
  if(v.startsWith("data:image/") && new TextEncoder().encode(v).byteLength > 16*1024) throw new Error("Logo is too large");
  if(!v.startsWith("data:image/") && new TextEncoder().encode(v).byteLength > 8*1024) throw new Error("Logo URL is too large");
  return v;
}

export async function quoteNearlyLaunch(input: LaunchForm, rpc=new NearRpcClient()): Promise<LaunchCost> {
  const icon=validateIcon(input.icon);
  const name=input.name.trim(), symbol=input.symbol.trim().toUpperCase(), description=input.description.trim();
  if(name.length<1 || name.length>32) throw new Error("Name must be 1–32 characters");
  if(symbol.length<1 || symbol.length>10 || !/^[A-Z0-9]+$/.test(symbol)) throw new Error("Symbol must be 1–10 ASCII letters/digits");
  if(description.length>500) throw new Error("Description must be at most 500 characters");
  const website=validateHttps(input.website,"Website"), twitter=validateHttps(input.twitter,"X"), telegram=validateHttps(input.telegram,"Telegram");
  const quote=input.quote || NEARLY_WNEAR;
  const quotes=await getNearlyLaunchQuotes(rpc);
  if(!quotes.some(q=>q.accountId===quote)) throw new Error("That NEARly launch pair is not currently available");
  const devBuy=yocto(input.devBuyNear||"0");
  const launchDevBuy=quote===NEARLY_WNEAR?devBuy:0n;
  const cost=await rpc.viewFunction<LaunchCost>(NEARLY_FACTORY,"quote_launch",{
    icon_bytes:new TextEncoder().encode(name+symbol+description).byteLength+new TextEncoder().encode(icon).byteLength,
    dev_buy:launchDevBuy.toString(),
    tax:Boolean(input.buyBps||input.sellBps)
  });
  for(const key of ["launch_fee","token_storage","pool_create","dcl_storage","dev_buy","total"]){
    if(typeof cost[key as keyof LaunchCost] !== "string" || !/^\d+$/.test(cost[key as keyof LaunchCost])) throw new Error("NEARly returned an invalid launch cost");
  }
  return cost;
}

export async function launchNearlyToken(input:LaunchForm, accountId:string, wallet:WebWalletConnector, rpc=new NearRpcClient()):Promise<{txHash:string;cost:LaunchCost}> {
  if(!accountId) throw new Error("Connect wallet first");
  const clean={...input,name:input.name.trim(),symbol:input.symbol.trim().toUpperCase(),description:input.description.trim()};
  const cost=await quoteNearlyLaunch(clean,rpc);
  const devBuy=yocto(clean.devBuyNear||"0");
  if(devBuy>0n && clean.quote!==NEARLY_WNEAR) throw new Error("NEARly native first buy is only available for the NEAR pair");
  const tax=[clean.buyBps,clean.sellBps,clean.creatorBps,clean.burnBps,clean.holdersBps];
  if(tax.some(x=>!Number.isInteger(x)||x<0) || clean.buyBps>400 || clean.sellBps>400) throw new Error("Invalid NEARly tax configuration");
  if((clean.buyBps||clean.sellBps) && clean.creatorBps+clean.burnBps+clean.holdersBps!==10000) throw new Error("Tax destinations must total 100%");
  const required=BigInt(cost.total);
  const args={
    name:clean.name,
    symbol:clean.symbol,
    icon:clean.icon.trim()||null,
    description:clean.description||null,
    links:{
      ...(clean.website.trim()?{website:validateHttps(clean.website,"Website")}:{}),
      ...(clean.twitter.trim()?{twitter:validateHttps(clean.twitter,"X")}:{}),
      ...(clean.telegram.trim()?{telegram:validateHttps(clean.telegram,"Telegram")}:{}),
    },
    ...(devBuy>0n?{dev_buy:devBuy.toString()}:{}),
    ...(clean.quote!==NEARLY_WNEAR?{quote:clean.quote}:{}),
    ...((clean.buyBps||clean.sellBps)?{tax:{buy_bps:clean.buyBps,sell_bps:clean.sellBps,creator_bps:clean.creatorBps,burn_bps:clean.burnBps,holders_bps:clean.holdersBps}}:{})
  };
  const result=await wallet.signAndSend({signerId:accountId,receiverId:NEARLY_FACTORY,actions:[{type:"FunctionCall",receiverId:NEARLY_FACTORY,methodName:"launch",args:{args},gas:300000000000000n,deposit:required}]});
  if(!result.transactionHash) throw new Error("Wallet did not return a transaction hash");
  return {txHash:result.transactionHash,cost};
}
