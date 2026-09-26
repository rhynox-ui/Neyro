import test from "node:test";
import assert from "node:assert/strict";
import { decodeIcon } from "../src/market/icon.js";

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("raster data URIs are decoded for serving", () => {
  const icon = decodeIcon(`data:image/png;base64,${PNG_1PX}`);
  assert.ok(icon && icon.kind === "image");
  assert.equal(icon.contentType, "image/png");
  assert.deepEqual([...icon.bytes.slice(1, 4)], [0x50, 0x4e, 0x47]); // "PNG"
  assert.equal((decodeIcon(`data:image/jpg;base64,${PNG_1PX}`) as { contentType: string }).contentType, "image/jpeg");
});

test("https and ipfs icons redirect; SVG and junk are skipped", () => {
  assert.deepEqual(decodeIcon("https://cdn.example/logo.png"), { kind: "redirect", url: "https://cdn.example/logo.png" });
  assert.deepEqual(decodeIcon("ipfs://bafyabc"), { kind: "redirect", url: "https://ipfs.io/ipfs/bafyabc" });
  assert.equal(decodeIcon("data:image/svg+xml;base64,PHN2Zz4="), null);
  assert.equal(decodeIcon("data:image/svg+xml,%3Csvg%3E"), null);
  assert.equal(decodeIcon("https://cdn.example/logo.svg"), null);
  assert.equal(decodeIcon("http://insecure.example/a.png"), null);
  assert.equal(decodeIcon(undefined), null);
});
