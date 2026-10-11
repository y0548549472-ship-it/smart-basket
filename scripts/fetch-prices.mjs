// מוריד קובצי PriceFull מהמאגרים השקופים ובונה data/prices.json
// הרצה: node scripts/fetch-prices.mjs   (Node 20+, בלי תלויות חיצוניות)
import { gunzipSync, inflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const MAX_STORES = Number(process.env.MAX_STORES || 4); // כמה סניפים לדגום מכל רשת
const UA = { "User-Agent": "Mozilla/5.0 (smart-basket)" };

// ---------- עזרים ----------
function decodeBuf(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  else if (buf[0] === 0x50 && buf[1] === 0x4b) buf = unzipFirst(buf); // zip
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  return buf.toString("utf8");
}
function unzipFirst(buf) {
  const method = buf.readUInt16LE(8), csize = buf.readUInt32LE(18);
  const n = buf.readUInt16LE(26), m = buf.readUInt16LE(28);
  const data = buf.subarray(30 + n + m, 30 + n + m + csize);
  return method === 0 ? data : inflateRawSync(data);
}
function parseItems(xml) {
  const out = [];
  const tag = (s, t) => {
    const r = s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "i"));
    return r ? r[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
  };
  for (const m of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/gi)) {
    const code = tag(m[1], "ItemCode");
    const name = tag(m[1], "ItemName");
    const price = parseFloat(tag(m[1], "ItemPrice"));
    if (code && name && price > 0) out.push({ code, name, price });
  }
  return out;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- שופרסל (פתוח, בלי התחברות) ----------
async function shufersal() {
  const links = [];
  for (let page = 1; page <= 10 && links.length < MAX_STORES; page++) {
    const r = await fetch(`https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page=${page}`, { headers: UA });
    const html = await r.text();
    const found = [...html.matchAll(/href="([^"]+\.gz[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    if (!found.length) break;
    links.push(...found);
  }
  const files = [];
  for (const url of links.slice(0, MAX_STORES)) {
    const r = await fetch(url, { headers: UA });
    files.push(parseItems(decodeBuf(Buffer.from(await r.arrayBuffer()))));
  }
  return files;
}

// ---------- רשתות על פורטל Cerberus (כניסה עם שם משתמש ציבורי) ----------
async function cerberus(username) {
  const base = "https://url.publishedprices.co.il";
  const jar = {};
  const store = (r) => (r.headers.getSetCookie?.() || []).forEach((c) => { const [kv] = c.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); });
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
  const req = (path, opt = {}) => fetch(base + path, { ...opt, redirect: "manual", headers: { ...UA, Cookie: cookie(), ...(opt.headers || {}) } });

  let r = await req("/login"); store(r);
  let csrf = (await r.text()).match(/name="csrftoken"\s+content="([^"]+)"|name="csrftoken"[^>]*value="([^"]+)"/);
  csrf = csrf && (csrf[1] || csrf[2]);
  r = await req("/login/user", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password: "", r: "", csrftoken: csrf || "" }) });
  store(r);
  r = await req("/file"); store(r);
  const page = await r.text();
  csrf = (page.match(/name="csrftoken"\s+content="([^"]+)"/) || [])[1] || csrf;
  r = await req("/file/json/dir", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ sEcho: "1", iColumns: "5", sColumns: ",,,,", iDisplayStart: "0", iDisplayLength: "100000", mDataProp_0: "fname", sSearch: "", bRegex: "false", iSortingCols: "0", cd: "/", csrftoken: csrf || "" }) });
  const json = await r.json();
  const names = (json.aaData || []).map((x) => x.fname).filter((n) => /^PriceFull/i.test(n));
  // קובץ אחד אחרון לכל סניף
  const latest = new Map();
  for (const n of names.sort()) latest.set(n.split("-").slice(0, 3).join("-"), n);
  const files = [];
  for (const n of [...latest.values()].slice(0, MAX_STORES)) {
    const d = await req("/file/d/" + encodeURIComponent(n));
    files.push(parseItems(decodeBuf(Buffer.from(await d.arrayBuffer()))));
  }
  return files;
}

// ---------- הרכבה ----------
const CHAINS = [
  { id: "shufersal", name: "שופרסל", run: shufersal },
  { id: "rami", name: "רמי לוי", run: () => cerberus("RamiLevi") },
  { id: "osherad", name: "אושר עד", run: () => cerberus("osherad") },
  { id: "yohananof", name: "יוחננוף", run: () => cerberus("yohananof") },
];

const products = new Map(); // barcode -> {name, prices:[]}
const okChains = [];
for (const chain of CHAINS) {
  try {
    const files = await chain.run();
    const perCode = new Map();
    for (const f of files) for (const it of f) {
      if (!perCode.has(it.code)) perCode.set(it.code, { name: it.name, prices: [] });
      perCode.get(it.code).prices.push(it.price);
    }
    if (!perCode.size) throw new Error("לא נמצאו מוצרים");
    const idx = okChains.length;
    okChains.push({ id: chain.id, name: chain.name });
    for (const [code, v] of perCode) {
      if (!products.has(code)) products.set(code, { name: v.name, p: [] });
      products.get(code).p[idx] = Math.round(median(v.prices) * 100) / 100;
    }
    console.log(`✔ ${chain.name}: ${perCode.size} מוצרים מ-${files.length} סניפים`);
  } catch (e) {
    console.warn(`✖ ${chain.name}: ${e.message}`);
  }
}
if (!okChains.length) { console.error("לא נשאבה אף רשת"); process.exit(1); }

const items = [...products].map(([code, v]) => [code, v.name, okChains.map((_, i) => v.p[i] ?? null)]);
mkdirSync("data", { recursive: true });
writeFileSync("data/prices.json", JSON.stringify({ updated: new Date().toISOString(), chains: okChains, items }));
console.log(`נכתב data/prices.json עם ${items.length} מוצרים`);
