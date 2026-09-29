/**
 * Token icons for Telegram link previews. NEP-141 metadata stores the icon
 * on chain, usually as a data: URI, which Telegram can't fetch, so the
 * Worker serves it at /icon/<token>. Telegram previews don't render SVG, so
 * only raster formats are served.
 */
export type IconSource =
  | { kind: "image"; contentType: string; bytes: Uint8Array }
  | { kind: "redirect"; url: string };

const RASTER = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_ICON_BYTES = 150_000;

export function decodeIcon(icon: string | undefined): IconSource | null {
  if (!icon) return null;
  const value = icon.trim();

  const data = RASTER.exec(value);
  if (data) {
    const bytes = Uint8Array.from(Buffer.from(data[2]!.replace(/\s+/g, ""), "base64"));
    if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) return null;
    const contentType = data[1]!.toLowerCase() === "image/jpg" ? "image/jpeg" : data[1]!.toLowerCase();
    return { kind: "image", contentType, bytes };
  }

  if (/^ipfs:\/\//i.test(value)) {
    return { kind: "redirect", url: `https://ipfs.io/ipfs/${value.slice("ipfs://".length)}` };
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !/\.svg($|\?)/i.test(url.pathname)) return { kind: "redirect", url: url.toString() };
  } catch {
    // not a URL
  }
  return null;
}
