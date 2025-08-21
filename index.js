"use strict";

/**
 * PrimeTube yt-dlp microservice (auth-wall resilient)
 * - Parallel client probing (tv/android/ios/web) + tiny merge window
 * - Coalesced in-flight, short-lived caches, bounded concurrency
 * - Cookie handling (PATH / B64_GZ / B64) with smart auto-selection
 * - Cookie-scoping per client (default only "web" uses cookies)
 * - Per-request overrides: ?nocookie=1, ?clients=tv,android,web
 * - Robust fallback: JSON (cookie→nocookie) → multi-client -g (cookie→nocookie)
 */

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const NodeCache = require("node-cache");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const app = express();
const PORT = Number(process.env.PORT || 8080);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cors());
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: "256kb" }));

app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/robots.txt", (_req, res) => res.type("text/plain").send("User-agent: *\nDisallow:\n"));

// ========= Config =========
const VCPUS = Number(process.env.CPU_LIMIT || (require("os").cpus().length || 1));
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TTL = Number(process.env.INFO_TTL || 300);
const URL_TTL_FALLBACK = Number(process.env.URL_TTL || 300);
const MAX_YTDLP = Math.max(2, Math.min(Number(process.env.MAX_YTDLP || VCPUS * 2), 8));
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 18000);
const YTDLP_SOCKET_TIMEOUT_SEC = Number(process.env.YTDLP_SOCKET_TIMEOUT_SEC || 12);
const YTDLP_RETRIES = Number(process.env.YTDLP_RETRIES || 1);
const YTDLP_FORCE_IPV4 = /^1|true$/i.test(String(process.env.YTDLP_FORCE_IPV4 || "1"));

// Prefer TV/Android first (less likely to hit web anti-bot)
const YT_CLIENTS = (process.env.YT_CLIENTS || "tv,android,ios,web").split(",").map(s => s.trim()).filter(Boolean);

// Only these clients use cookies (default: web only)
const COOKIE_CLIENTS = (process.env.COOKIE_CLIENTS || "web").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Global cookie kill switch
const FORCE_NO_COOKIES = /^1|true$/i.test(String(process.env.FORCE_NO_COOKIES || ""));

// Small merge window for late JSON successes
const FIRST_GOOD_MERGE_WINDOW_MS = Number(process.env.FIRST_GOOD_MERGE_WINDOW_MS || 150);

// Backpressure
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 64);

// ========= Cookie auto-selection =========
const ENV_B64_GZ = process.env.YT_COOKIES_B64_GZ || "";
const ENV_B64    = process.env.YT_COOKIES_B64 || "";
let ENV_PATH     = process.env.YT_COOKIES_PATH || process.env.YT_COOKIES || "";

if (ENV_B64_GZ) console.log("env YT_COOKIES_B64_GZ length:", String(ENV_B64_GZ).length);
if (ENV_B64)    console.log("env YT_COOKIES_B64 length:", String(ENV_B64).length);

function filterDomains(text) {
  const keepers = [
    /^#/, // comments + #HttpOnly_
    /(^|\s)\.?(youtube|googlevideo|ytimg)\.com\s/i,
    /(^|\s)\.?(google|accounts\.google)\.com\s/i,
    /(^|\s)\.?(gstatic|youtube\-nocookie)\.com\s/i,
  ];
  return text.split(/\r?\n/).filter(l => l.trim() === "" || keepers.some(re => re.test(l))).join("\n") + "\n";
}
function hasAny(str, names) {
  return names.some(n => new RegExp(`\\t${n}\\t`, "i").test(str));
}
function cookieHealth(text) {
  const googleAuth = hasAny(text, ["SID","HSID","SSID","APISID","SAPISID","__Secure-1PSID","__Secure-3PSID","__Secure-3PAPISID"]);
  const ytBasics   = hasAny(text, ["CONSENT","YSC","PREF","VISITOR_INFO1_LIVE"]);
  return { googleAuth, ytBasics };
}
function decodeSource() {
  const candidates = [];

  // PATH
  if (ENV_PATH && fs.existsSync(ENV_PATH)) {
    try {
      const t = fs.readFileSync(ENV_PATH, "utf8");
      const h = cookieHealth(t);
      candidates.push({ name: "PATH", bytes: t.length, text: t, health: h });
    } catch (e) { console.warn("Cookie PATH read failed:", e.message); }
  }
  // B64_GZ
  if (ENV_B64_GZ) {
    try {
      const raw = Buffer.from(String(ENV_B64_GZ).replace(/\s+/g, ""), "base64");
      const t = zlib.gunzipSync(raw).toString("utf8");
      const h = cookieHealth(t);
      candidates.push({ name: "B64_GZ", bytes: t.length, text: t, health: h });
    } catch (e) { console.warn("Cookie B64_GZ decode failed:", e.message); }
  }
  // B64
  if (ENV_B64) {
    try {
      const t = Buffer.from(String(ENV_B64).replace(/\s+/g, ""), "base64").toString("utf8");
      const h = cookieHealth(t);
      candidates.push({ name: "B64", bytes: t.length, text: t, health: h });
    } catch (e) { console.warn("Cookie B64 decode failed:", e.message); }
  }

  if (!candidates.length) return null;

  // Prefer sources that have googleAuth=true; among those, pick the largest
  const authOK = candidates.filter(c => c.health.googleAuth);
  const pickFrom = authOK.length ? authOK : candidates;
  pickFrom.sort((a, b) => b.bytes - a.bytes);
  const chosen = pickFrom[0];
  return chosen;
}
function writeTmpCookies(text) {
  const dest = path.join(os.tmpdir(), "youtube.cookies.txt");
  const finalText = /^1|true$/i.test(String(process.env.NO_COOKIE_FILTER || "")) ? text : filterDomains(text);
  fs.writeFileSync(dest, finalText, "utf8");
  try { fs.chmodSync(dest, 0o600); } catch {}
  console.log(`🔁 Cookies materialized to ${dest} (${finalText.length} bytes)`);
  return { path: dest, bytes: finalText.length, health: cookieHealth(finalText) };
}

let YT_COOKIES = "";
let COOKIE_BYTES = 0;
let COOKIE_HEALTH = { googleAuth: false, ytBasics: false };
let COOKIE_SOURCE = "NONE";

try {
  if (!FORCE_NO_COOKIES) {
    const chosen = decodeSource();
    if (chosen) {
      COOKIE_SOURCE = chosen.name;
      const out = writeTmpCookies(chosen.text);
      YT_COOKIES = out.path;
      COOKIE_BYTES = out.bytes;
      COOKIE_HEALTH = out.health;
      if (!COOKIE_HEALTH.googleAuth) {
        console.warn("⚠️ Cookie jar lacks Google auth cookies (SID/SAPISID family). Sign-in may be required.");
      }
      if (COOKIE_BYTES < 20000) {
        console.warn("⚠️ Cookie jar looks small (<20KB). You likely exported partial cookies; export full profile cookies.");
      }
      console.log(`✅ Cookies loaded (${COOKIE_BYTES} bytes) from: ${YT_COOKIES} (source=${COOKIE_SOURCE})`);
    } else {
      console.warn("⚠️ No cookie sources resolved. Proceeding without cookies.");
    }
  } else {
    console.warn("ℹ️ FORCE_NO_COOKIES=1 — cookies disabled.");
  }
} catch (e) {
  console.error("❌ Failed to materialize cookies:", e.message);
}

const HAS_COOKIES = Boolean(YT_COOKIES && fs.existsSync(YT_COOKIES) && !FORCE_NO_COOKIES);

app.get("/cookiez", (_req, res) => {
  res.json({
    hasCookies: HAS_COOKIES,
    bytes: COOKIE_BYTES,
    path: HAS_COOKIES ? YT_COOKIES : null,
    checks: COOKIE_HEALTH,
    cookieSource: COOKIE_SOURCE,
    clients: YT_CLIENTS,
    cookieClients: COOKIE_CLIENTS,
    forceNoCookies: FORCE_NO_COOKIES
  });
});

// ========= Cache =========
const cache = new NodeCache({
  stdTTL: INFO_TTL,
  checkperiod: Math.max(30, Math.min(INFO_TTL, 120)),
  useClones: false
});

// ========= Concurrency =========
let running = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      running++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally { running--; tick(); }
    });
    tick();
  });
}
function tick() {
  while (running < MAX_YTDLP && queue.length) { const job = queue.shift(); if (job) job(); }
}

// ========= Helpers =========
const YT_ID = /^[\w-]{11}$/;
function setCacheHeaders(res, seconds, extra = "public") {
  res.set("Cache-Control", `${extra}, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${Math.ceil(seconds/2)}`);
}
function setShortPrivate(res, seconds = 60) {
  res.set("Cache-Control", `private, max-age=${seconds}, stale-while-revalidate=${Math.ceil(seconds/2)}`);
}
function computeUrlTtlSec(urlStr, { floor = 30, ceil = 3600, safety = 30 } = {}) {
  try {
    const u = new URL(urlStr);
    const exp = Number(u.searchParams.get("expire") || u.searchParams.get("Expires"));
    if (Number.isFinite(exp) && exp > 0) {
      const now = Math.floor(Date.now()/1000);
      return Math.max(floor, Math.min(ceil, exp - now - safety));
    }
  } catch {}
  return URL_TTL_FALLBACK;
}
const pickUrl = (f) => f?.url || f?.manifest_url || f?.hls_manifest_url || f?.dash_manifest_url || f?.fragment_base_url || null;
const looksLikeHls = (url, proto, ext) =>
  (typeof proto === "string" && proto.includes("m3u8")) ||
  (typeof ext === "string" && ext.includes("m3u8")) ||
  (typeof url === "string" && url.includes(".m3u8"));
const isStoryboard = (f) => f?.protocol === "mhtml" || /^sb\d/.test(String(f?.format_id || ""));
function scoreInfo(info) {
  const fmts = Array.isArray(info?.formats) ? info.formats : [];
  const maxH = fmts.reduce((m, f) => Math.max(m, Number(f?.height) || 0), 0);
  const adaptiveCount = fmts.filter(f => (f?.vcodec && f.vcodec !== "none") && (!f?.acodec || f.acodec === "none")).length;
  return maxH * 1000 + adaptiveCount;
}
function mergeInfos(infos) {
  if (!infos.length) return { formats: [] };
  const out = { ...infos[0], formats: [] };
  const seen = new Set();
  for (const info of infos) {
    const fmts = Array.isArray(info?.formats) ? info.formats : [];
    for (const f of fmts) {
      const url = pickUrl(f); if (!url) continue;
      const key = `${String(f?.format_id||"")}|${String(f?.ext||"")}|${String(f?.protocol||"")}|${String(f?.height||"")}|${url.slice(0,120)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.formats.push(f);
    }
  }
  return out;
}
const children = new Set();
function track(child) { try { children.add(child.pid); } catch {} child.on("close", () => { try { children.delete(child.pid); } catch {} }); return child; }

// ========= Error helpers =========
function isAuthWallError(msg = "") {
  const s = String(msg);
  return /Sign in to confirm you.?re not a bot/i.test(s) ||
         /This video may be inappropriate/i.test(s) ||
         /account associated/i.test(s);
}
function willUseCookiesFor(client, requestedUseCookies) {
  return requestedUseCookies && HAS_COOKIES && COOKIE_CLIENTS.includes(String(client || "").toLowerCase());
}

// ========= yt-dlp invocations =========
function spawnYtDlpJSON(url, playerClient = "tv", useCookies = true) {
  return schedule(() => new Promise((resolve, reject) => {
    const allowCookies = willUseCookiesFor(playerClient, useCookies);
    const args = [
      "-J",
      "--no-warnings",
      "--no-progress",
      "--extractor-args", `youtube:player_client=${playerClient}`,
      "--socket-timeout", String(YTDLP_SOCKET_TIMEOUT_SEC),
      "--retries", String(YTDLP_RETRIES),
    ];
    if (YTDLP_FORCE_IPV4) args.unshift("-4");
    if (allowCookies) args.push("--cookies", YT_COOKIES);
    args.push(url);

    const child = track(spawn(YTDLP_BIN, args, { stdio: ["ignore","pipe","pipe"] }));
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (err += c));

    child.on("error", e => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (!out && code !== 0) {
        const em = `yt-dlp exit ${code} [JSON client=${playerClient} cookies=${allowCookies}]: ${err.split("\n").slice(-6).join(" ")}`;
        if (isAuthWallError(em) && allowCookies) {
          console.warn(`⚠️ AUTH wall (JSON) client=${playerClient} with cookies → retrying without cookies`);
          spawnYtDlpJSON(url, playerClient, false).then(resolve).catch(reject);
          return;
        }
        const e = new Error(em); if (isAuthWallError(em)) e.code = "AUTH_REQUIRED";
        return reject(e);
      }
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`Invalid JSON from yt-dlp: ${e.message}`)); }
    });
  }));
}

function spawnYtDlpBestUrl(url, playerClient = "tv", useCookies = true) {
  return schedule(() => new Promise((resolve, reject) => {
    const allowCookies = willUseCookiesFor(playerClient, useCookies);
    const args = [
      "-g",
      "--no-warnings",
      "--no-progress",
      "--extractor-args", `youtube:player_client=${playerClient}`,
      "--socket-timeout", String(YTDLP_SOCKET_TIMEOUT_SEC),
      "--retries", String(YTDLP_RETRIES),
      "-f", 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',
    ];
    if (YTDLP_FORCE_IPV4) args.unshift("-4");
    if (allowCookies) args.push("--cookies", YT_COOKIES);
    args.push(url);

    const child = track(spawn(YTDLP_BIN, args, { stdio: ["ignore","pipe","pipe"] }));
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", c => (out += c));
    child.stderr.on("data", c => (err += c));

    child.on("error", e => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        const em = `yt-dlp exit ${code} [-g client=${playerClient} cookies=${allowCookies}]: ${err.split("\n").slice(-6).join(" ")}`;
        if (isAuthWallError(em) && allowCookies) {
          console.warn(`⚠️ AUTH wall (-g) client=${playerClient} with cookies → retrying without cookies`);
          spawnYtDlpBestUrl(url, playerClient, false).then(resolve).catch(reject);
          return;
        }
        const e = new Error(em); if (isAuthWallError(em)) e.code = "AUTH_REQUIRED";
        return reject(e);
      }
      const direct = out.trim().split("\n").pop();
      if (!direct) return reject(new Error("No direct URL from yt-dlp -g"));
      console.log(`→ -g OK client=${playerClient} cookies=${allowCookies} (${direct.includes(".m3u8")?"HLS":"MP4"})`);
      resolve(direct);
    });
  }));
}

async function spawnBestUrlAnyClient(url, opts = {}) {
  const clients = Array.isArray(opts.clients) && opts.clients.length ? opts.clients : YT_CLIENTS;
  const wantCookies = !opts.nocookie;
  let authHit = false, lastErr = null;
  for (const client of clients) {
    console.log(`Trying -g client=${client} cookies=${willUseCookiesFor(client, wantCookies)}`);
    try {
      const direct = await spawnYtDlpBestUrl(url, client, wantCookies);
      return { url: direct, client };
    } catch (e) {
      if (e && e.code === "AUTH_REQUIRED") authHit = true;
      lastErr = e;
    }
  }
  if (authHit) { const err = new Error("Auth required"); err.code = "AUTH_REQUIRED"; throw err; }
  throw lastErr || new Error("Failed to resolve best URL");
}

// ========= Format assembly =========
function buildFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const videoFormats = formats
    .filter(f => !isStoryboard(f))
    .filter(f => (f?.vcodec && f.vcodec !== "none") || f?.height || f?.manifest_url || f?.hls_manifest_url)
    .map(f => {
      const url = pickUrl(f);
      const height = Number(f?.height) || 0;
      const hls = looksLikeHls(url, f?.protocol, f?.ext);
      return {
        format_id: f?.format_id,
        extension: f?.ext || (hls ? "m3u8" : "mp4"),
        resolution: height ? `${height}p` : "unknown",
        height,
        protocol: f?.protocol || (hls ? "m3u8_native" : "https"),
        has_audio: hls ? true : !!(f?.acodec && f.acodec !== "none"),
        bandwidth: f?.tbr || f?.abr || null,
        url,
      };
    })
    .filter(fmt => fmt.url)
    .filter((fmt, i, arr) => arr.findIndex(x => x.resolution === fmt.resolution && x.protocol === fmt.protocol) === i)
    .sort((a, b) => a.height - b.height);

  const audioFormats = formats
    .filter(f => !isStoryboard(f))
    .filter(f => (!f?.vcodec || f?.vcodec === "none") && f?.acodec && f.acodec !== "none")
    .map(f => ({
      format_id: f?.format_id,
      extension: f?.ext || "m4a",
      protocol: f?.protocol || "https",
      bitrate: f?.abr || f?.tbr || null,
      url: pickUrl(f),
    }))
    .filter(fmt => fmt.url)
    .filter((fmt, i, arr) => arr.findIndex(x => x.bitrate === fmt.bitrate && x.protocol === fmt.protocol) === i)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return { videoFormats, audioFormats };
}
function pickBestMergedMp4(info, maxHeight) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const merged = formats.filter(f => f?.ext === "mp4" && pickUrl(f) && f?.vcodec && f.vcodec !== "none" && f?.acodec && f.acodec !== "none" && f?.height);
  if (!merged.length) return null;
  const below = merged.filter(f => f.height <= maxHeight).sort((a,b)=>b.height-a.height)[0];
  if (below) return below;
  return merged.filter(f => f.height > maxHeight).sort((a,b)=>a.height-b.height)[0] || null;
}

// ========= In-flight de-dup =========
const inflight = new Map();

// ========= Fast fetch & merge (with multi-client -g fallback) =========
async function fetchInfoMergedFast(id, opts = {}) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const clients = Array.isArray(opts.clients) && opts.clients.length ? opts.clients : YT_CLIENTS;
  const wantCookies = !opts.nocookie;

  const all = clients.map(client =>
    spawnYtDlpJSON(url, client, wantCookies).then(info => {
      const fmts = Array.isArray(info?.formats) ? info.formats : [];
      const usable = fmts.some(f => pickUrl(f));
      if (!usable) throw new Error("No usable formats");
      return { client, info, score: scoreInfo(info) };
    })
  );

  let first;
  try {
    first = await Promise.any(all);
  } catch (e) {
    try {
      const { url: directUrl, client: gClient } = await spawnBestUrlAnyClient(url, { clients, nocookie: opts.nocookie });
      return {
        info: { id, formats: [{ format_id: "best", ext: directUrl.includes(".m3u8") ? "m3u8" : "mp4", protocol: directUrl.includes(".m3u8") ? "m3u8" : "https", vcodec: "unknown", acodec: "unknown", url: directUrl }] },
        client: `best-url:${gClient}`,
      };
    } catch (eg) {
      const authy = (e && e.code === "AUTH_REQUIRED") || (eg && eg.code === "AUTH_REQUIRED");
      if (authy) { const err = new Error("Auth required"); err.code = "AUTH_REQUIRED"; throw err; }
      throw eg;
    }
  }

  const gather = Promise.allSettled(all);
  const timed = await Promise.race([gather, new Promise(r => setTimeout(() => r("timeout"), FIRST_GOOD_MERGE_WINDOW_MS))]);
  if (timed === "timeout") return { info: first.info, client: first.client };

  const successes = timed.filter(s => s.status === "fulfilled").map(s => s.value);
  const merged = mergeInfos(successes.map(t => t.info));
  const best = successes.sort((a,b)=>b.score-a.score)[0];
  return { info: merged, client: best?.client || first.client };
}

// ========= Backpressure =========
function rejectIfBusy(res) {
  if (queue.length > MAX_QUEUE) {
    res.set("Retry-After", "3");
    res.status(503).json({ error: "Busy, please retry" });
    return true;
  }
  return false;
}

// ========= Routes =========
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    running, queued: queue.length, maxYtDlp: MAX_YTDLP,
    cacheKeys: cache.keys().length,
    uptimeSec: Math.floor(process.uptime()),
    rssMB: Math.round(process.memoryUsage().rss / (1024*1024)),
    clients: YT_CLIENTS,
    cookieClients: COOKIE_CLIENTS,
    forceNoCookies: FORCE_NO_COOKIES,
    cookieSource: COOKIE_SOURCE,
    cookieBytes: COOKIE_BYTES,
    checks: COOKIE_HEALTH
  });
});

function parseClientListParam(q) {
  const raw = String(q || "").trim();
  if (!raw) return null;
  const arr = raw.split(",").map(s => s.trim()).filter(Boolean);
  return arr.length ? arr : null;
}

// Prewarm
app.post("/prewarm", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.body?.id || "").trim();
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const nocookie = /^1|true$/i.test(String(req.query.nocookie || ""));
    const clients = parseClientListParam(req.query.clients) || undefined;

    const cacheKey = `stream_${nocookie ? "NC_" : ""}${clients? clients.join("|") + "_" : ""}${id}`;
    if (!cache.get(cacheKey)) {
      const { info } = await fetchInfoMergedFast(id, { nocookie, clients });
      cache.set(cacheKey, buildFormats(info), 60);
    }
    setShortPrivate(res, 15);
    res.json({ ok: true });
  } catch (e) {
    if (e?.code === "AUTH_REQUIRED") {
      return res.status(403).json({ error: "YouTube requires sign-in (anti-bot). Provide cookies.", code: "AUTH_REQUIRED", checks: COOKIE_HEALTH });
    }
    console.error("/prewarm error:", e.message);
    res.status(500).json({ error: "Failed to prewarm" });
  }
});

// Formats JSON
app.get("/stream", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.query.id || "").trim().replace(/^\$/, "");
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const nocookie = /^1|true$/i.test(String(req.query.nocookie || ""));
    const clients = parseClientListParam(req.query.clients) || undefined;

    const cacheKey = `stream_${nocookie ? "NC_" : ""}${clients? clients.join("|") + "_" : ""}${id}`;
    const hit = cache.get(cacheKey);
    if (hit) { res.set("X-PT-Cache", "HIT"); setShortPrivate(res, 60); return res.json(hit); }

    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, (async () => {
        const { info, client } = await fetchInfoMergedFast(id, { nocookie, clients });
        const result = buildFormats(info);
        cache.set(cacheKey, result, 60);
        return { result, client };
      })().finally(() => setTimeout(() => inflight.delete(cacheKey), 0)));
    }

    const { result, client } = await inflight.get(cacheKey);
    res.set("X-PT-Cache", `MISS;client=${client}`);
    setShortPrivate(res, 60);
    res.json(result);
  } catch (e) {
    if (e?.code === "AUTH_REQUIRED") {
      res.set("X-PT-Auth", "MISSING");
      return res.status(403).json({ error: "YouTube requires sign-in (anti-bot). Provide cookies.", code: "AUTH_REQUIRED", checks: COOKIE_HEALTH });
    }
    console.error("/stream error:", e.message);
    res.status(500).json({ error: "Failed to fetch formats" });
  }
});

// 480p redirect
app.get("/stream480", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.query.id || "").trim().replace(/^\$/, "");
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const nocookie = /^1|true$/i.test(String(req.query.nocookie || ""));
    const clients = parseClientListParam(req.query.clients) || undefined;

    const cacheKey = `stream480_${nocookie ? "NC_" : ""}${clients? clients.join("|") + "_" : ""}${id}`;
    const cached = cache.get(cacheKey);
    if (cached) { res.set("X-PT-Cache", "HIT"); setCacheHeaders(res, computeUrlTtlSec(cached)); return res.redirect(cached); }

    const { info } = await fetchInfoMergedFast(id, { nocookie, clients });
    const fmt = pickBestMergedMp4(info, 480);
    if (fmt?.url) {
      const ttl = computeUrlTtlSec(fmt.url);
      cache.set(cacheKey, fmt.url, ttl);
      res.set("X-PT-Cache", "MISS");
      setCacheHeaders(res, ttl);
      return res.redirect(fmt.url);
    }

    const { url: directUrl } = await spawnBestUrlAnyClient(`https://www.youtube.com/watch?v=${id}`, { nocookie, clients });
    const ttl = computeUrlTtlSec(directUrl);
    cache.set(cacheKey, directUrl, ttl);
    setCacheHeaders(res, ttl);
    return res.redirect(directUrl);
  } catch (e) {
    if (e?.code === "AUTH_REQUIRED") { res.set("X-PT-Auth", "MISSING"); return res.status(403).json({ error: "Auth required for this video", code: "AUTH_REQUIRED", checks: COOKIE_HEALTH }); }
    console.error("/stream480 error:", e.message);
    res.status(500).json({ error: "Failed to pick 480p stream" });
  }
});

// Best MP4 under ?max=
app.get("/streamMp4", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.query.id || "").trim().replace(/^\$/, "");
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Bad id" });

    const nocookie = /^1|true$/i.test(String(req.query.nocookie || ""));
    const clients = parseClientListParam(req.query.clients) || undefined;

    const max = Math.max(144, Math.min(2160, parseInt(req.query.max || "720", 10) || 720));
    const cacheKey = `mp4_${max}_${nocookie ? "NC_" : ""}${clients? clients.join("|") + "_" : ""}${id}`;
    const cached = cache.get(cacheKey);
    if (cached) { res.set("X-PT-Cache", "HIT"); setCacheHeaders(res, computeUrlTtlSec(cached)); return res.redirect(cached); }

    const { info } = await fetchInfoMergedFast(id, { nocookie, clients });
    const fmt = pickBestMergedMp4(info, max);
    if (fmt?.url) {
      const ttl = computeUrlTtlSec(fmt.url);
      cache.set(cacheKey, fmt.url, ttl);
      res.set("X-PT-Cache", "MISS");
      setCacheHeaders(res, ttl);
      return res.redirect(fmt.url);
    }

    const { url: directUrl } = await spawnBestUrlAnyClient(`https://www.youtube.com/watch?v=${id}`, { nocookie, clients });
    const ttl = computeUrlTtlSec(directUrl);
    cache.set(cacheKey, directUrl, ttl);
    setCacheHeaders(res, ttl);
    return res.redirect(directUrl);
  } catch (e) {
    if (e?.code === "AUTH_REQUIRED") { res.set("X-PT-Auth", "MISSING"); return res.status(403).json({ error: "Auth required for this video", code: "AUTH_REQUIRED", checks: COOKIE_HEALTH }); }
    console.error("/streamMp4 error:", e.message);
    res.status(502).json({ error: e.message || "Failed to resolve MP4" });
  }
});

// Shorts filter
app.post("/filterPlayable", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const items = req.body?.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Invalid input" });

    const ids = Array.from(new Set(items.map(it => it?.id?.videoId).filter(id => typeof id === "string" && YT_ID.test(id))));
    const tasks = ids.map(id => schedule(async () => {
      try {
        const { info } = await fetchInfoMergedFast(id);
        const fmts = Array.isArray(info?.formats) ? info.formats : [];
        const hasHls = fmts.some(f => looksLikeHls(pickUrl(f), f?.protocol, f?.ext));
        if (hasHls) return id;
        const hasVideo = fmts.some(f => f?.vcodec && f.vcodec !== "none" && pickUrl(f));
        const hasAudio = fmts.some(f => f?.acodec && f.acodec !== "none" && pickUrl(f));
        return hasVideo && hasAudio ? id : null;
      } catch { return null; }
    }));

    const results = await Promise.all(tasks);
    const playableSet = new Set(results.filter(Boolean));
    const playable = items.filter(it => playableSet.has(it?.id?.videoId));

    setShortPrivate(res, 60);
    res.json({ playable });
  } catch (e) {
    console.error("/filterPlayable error:", e.message);
    res.status(500).json({ error: "Failed to filter" });
  }
});

// ========= Shutdown =========
process.on("SIGTERM", () => { for (const pid of [...children]) { try { process.kill(pid,"SIGKILL"); } catch {} } process.exit(0); });
process.on("SIGINT",  () => { for (const pid of [...children]) { try { process.kill(pid,"SIGKILL"); } catch {} } process.exit(0); });

// ========= Listen =========
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
