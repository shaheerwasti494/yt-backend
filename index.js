"use strict";

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
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

// Slightly higher threshold to avoid tiny-response compression overhead
app.use(cors());
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: "256kb" }));

// ---- Root/health (keep PaaS health checks happy) ----
app.get("/", (_req, res) => res.status(200).send("ok"));

// ========= Config =========
const VCPUS = Number(process.env.CPU_LIMIT || os.cpus().length || 1);

const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TTL = Number(process.env.INFO_TTL || 300);        // seconds (info JSON cache)
const URL_TTL_FALLBACK = Number(process.env.URL_TTL || 300); // seconds (redirect URL cache)

// Auto-size yt-dlp parallelism: ~2x vCPUs, within sane bounds
const MAX_YTDLP = Math.max(2, Math.min(Number(process.env.MAX_YTDLP || VCPUS * 2), 8));

const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 18000); // kill hung yt-dlp quickly
const YTDLP_SOCKET_TIMEOUT_SEC = Number(process.env.YTDLP_SOCKET_TIMEOUT_SEC || 12);
const YTDLP_RETRIES = Number(process.env.YTDLP_RETRIES || 1);
const YTDLP_FORCE_IPV4 = /^1|true$/i.test(String(process.env.YTDLP_FORCE_IPV4 || "1")); // often cleaner routes

// Prefer android/tv first for quick HLS; still merge others opportunistically
const YT_CLIENTS = (process.env.YT_CLIENTS || "android,tv,web,ios")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Return first good immediately, but wait a tiny window to merge late arrivals
const FIRST_GOOD_MERGE_WINDOW_MS = Number(process.env.FIRST_GOOD_MERGE_WINDOW_MS || 150);

// Backpressure: fail fast when queue explodes so autoscaling can pick up
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 64);

// ========= Cookies (Path A: file or base64) =========
let YT_COOKIES = process.env.YT_COOKIES || "";
const B64_GZ = process.env.YT_COOKIES_B64_GZ || "";
const B64    = process.env.YT_COOKIES_B64     || "";

if (B64_GZ) console.log("env YT_COOKIES_B64_GZ length:", String(B64_GZ).length);
if (B64)    console.log("env YT_COOKIES_B64 length:",    String(B64).length);

function filterDomains(text) {
  // Keep comments AND auth-critical Google domains, not just youtube/*
  const keepers = [
    /^#/,                            // comments + #HttpOnly_
    /(^|\s)\.?(youtube|googlevideo|ytimg)\.com\s/i,
    /(^|\s)\.?(google|accounts\.google)\.com\s/i,
    /(^|\s)\.?(gstatic|youtube\-nocookie)\.com\s/i,
  ];
  return (
    text
      .split(/\r?\n/)
      .filter((l) => l.trim() === "" || keepers.some((re) => re.test(l)))
      .join("\n") + "\n"
  );
}


try {
  if (!YT_COOKIES && (B64_GZ || B64)) {
    const tmpFile = path.join(os.tmpdir(), "youtube.cookies.txt");
    if (B64_GZ) {
      const raw = Buffer.from(String(B64_GZ).replace(/\s+/g, ""), "base64");
      const text = zlib.gunzipSync(raw).toString("utf8");
      fs.writeFileSync(tmpFile, filterDomains(text), "utf8");
    } else if (B64) {
      const text = Buffer.from(String(B64).replace(/\s+/g, ""), "base64").toString("utf8");
      fs.writeFileSync(tmpFile, filterDomains(text), "utf8");
    }
    YT_COOKIES = tmpFile;
  }
} catch (e) {
  console.error("❌ Failed to materialize cookies:", e.message);
}

const HAS_COOKIES = Boolean(YT_COOKIES && fs.existsSync(YT_COOKIES));
if (HAS_COOKIES) {
  try {
    const stat = fs.statSync(YT_COOKIES);
    console.log(`✅ Cookies loaded (${stat.size} bytes) from: ${YT_COOKIES}`);
  } catch (e) {
    console.warn("⚠️ Cookies path set but unreadable:", e.message);
  }
} else {
  console.warn("⚠️ No cookies found. Age/region/anti-bot checks may fail.");
}

// ========= Cache =========
const cache = new NodeCache({
  stdTTL: INFO_TTL,
  checkperiod: Math.max(30, Math.min(INFO_TTL, 120)), // keep memory tidy
  useClones: false
});

// ========= Concurrency (semaphore) =========
let running = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      running++;
      try {
        const v = await fn();
        resolve(v);
      } catch (e) {
        reject(e);
      } finally {
        running--;
        tick();
      }
    });
    tick();
  });
}
function tick() {
  while (running < MAX_YTDLP && queue.length) {
    const job = queue.shift();
    if (job) job();
  }
}

// ========= Helpers =========
const YT_ID = /^[\w-]{11}$/;

function setCacheHeaders(res, seconds, extra = "public") {
  // add stale-while-revalidate for smoother cache behavior
  res.set(
    "Cache-Control",
    `${extra}, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=${Math.ceil(seconds / 2)}`
  );
}
function setShortPrivate(res, seconds = 60) {
  res.set(
    "Cache-Control",
    `private, max-age=${seconds}, stale-while-revalidate=${Math.ceil(seconds / 2)}`
  );
}

function computeUrlTtlSec(urlStr, { floor = 30, ceil = 3600, safety = 30 } = {}) {
  try {
    const u = new URL(urlStr);
    const exp = Number(u.searchParams.get("expire") || u.searchParams.get("Expires"));
    if (Number.isFinite(exp) && exp > 0) {
      const now = Math.floor(Date.now() / 1000);
      const remain = exp - now - safety;
      return Math.max(floor, Math.min(ceil, remain));
    }
  } catch (_e) {}
  return URL_TTL_FALLBACK;
}

const pickUrl = (f) =>
  f?.url ||
  f?.manifest_url ||
  f?.hls_manifest_url ||
  f?.dash_manifest_url ||
  f?.fragment_base_url ||
  null;

const looksLikeHls = (url, proto, ext) =>
  (typeof proto === "string" && proto.includes("m3u8")) ||
  (typeof ext === "string" && ext.includes("m3u8")) ||
  (typeof url === "string" && url.includes(".m3u8"));

const isStoryboard = (f) =>
  f?.protocol === "mhtml" || /^sb\d/.test(String(f?.format_id || ""));

function scoreInfo(info) {
  const fmts = Array.isArray(info?.formats) ? info.formats : [];
  const maxH = fmts.reduce((m, f) => Math.max(m, Number(f?.height) || 0), 0);
  const adaptiveCount = fmts.filter(
    (f) => (f?.vcodec && f.vcodec !== "none") && (!f?.acodec || f.acodec === "none")
  ).length;
  return maxH * 1000 + adaptiveCount;
}

function mergeInfos(infos) {
  if (!infos.length) return { formats: [] };
  const out = { ...infos[0], formats: [] };
  const seen = new Set();
  for (const info of infos) {
    const fmts = Array.isArray(info?.formats) ? info.formats : [];
    for (const f of fmts) {
      const url = pickUrl(f);
      if (!url) continue;
      const key =
        String(f?.format_id || "") +
        "|" + String(f?.ext || "") +
        "|" + String(f?.protocol || "") +
        "|" + String(f?.height || "") +
        "|" + url.slice(0, 120);
      if (seen.has(key)) continue;
      seen.add(key);
      out.formats.push(f);
    }
  }
  return out;
}

// Track child PIDs so we can kill them on shutdown
const children = new Set();
function track(child) {
  try { children.add(child.pid); } catch {}
  child.on("close", () => { try { children.delete(child.pid); } catch {} });
  return child;
}

// ========= yt-dlp invocations =========
function spawnYtDlpJSON(url, playerClient = "android") {
  return schedule(
    () =>
      new Promise((resolve, reject) => {
        const args = [
          "-J",
          "--no-warnings",
          "--no-progress",
          "--extractor-args", `youtube:player_client=${playerClient}`,
          "--socket-timeout", String(YTDLP_SOCKET_TIMEOUT_SEC),
          "--retries", String(YTDLP_RETRIES),
        ];
        if (YTDLP_FORCE_IPV4) args.unshift("-4");
        if (HAS_COOKIES) { args.push("--cookies", YT_COOKIES); }
        args.push(url);

        const child = track(spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] }));
        let out = "";
        let err = "";
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));

        child.on("error", (e) => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (!out && code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.split("\n").slice(-6).join(" ")}`));
          try { resolve(JSON.parse(out)); } catch (e) { reject(new Error(`Invalid JSON from yt-dlp: ${e.message}`)); }
        });
      })
  );
}

function spawnYtDlpBestUrl(url, playerClient = "android") {
  return schedule(
    () =>
      new Promise((resolve, reject) => {
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
        if (HAS_COOKIES) args.push("--cookies", YT_COOKIES);
        args.push(url);

        const child = track(spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] }));
        let out = "", err = "";
        const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (err += c));

        child.on("error", (e) => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.split("\n").slice(-6).join(" ")}`));
          const direct = out.trim().split("\n").pop();
          if (!direct) return reject(new Error("No direct URL from yt-dlp -g"));
          resolve(direct);
        });
      })
  );
}

// ========= Format assembly =========
function buildFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const videoFormats = formats
    .filter((f) => !isStoryboard(f))
    .filter((f) =>
      (f?.vcodec && f.vcodec !== "none") ||
      f?.height ||
      f?.manifest_url ||
      f?.hls_manifest_url
    )
    .map((f) => {
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
    .filter((fmt) => fmt.url)
    .filter((fmt, i, arr) => arr.findIndex(
      (x) => x.resolution === fmt.resolution && x.protocol === fmt.protocol
    ) === i)
    .sort((a, b) => a.height - b.height);

  const audioFormats = formats
    .filter((f) => !isStoryboard(f))
    .filter((f) => (!f?.vcodec || f?.vcodec === "none") && f?.acodec && f.acodec !== "none")
    .map((f) => ({
      format_id: f?.format_id,
      extension: f?.ext || "m4a",
      protocol: f?.protocol || "https",
      bitrate: f?.abr || f?.tbr || null,
      url: pickUrl(f),
    }))
    .filter((fmt) => fmt.url)
    .filter((fmt, i, arr) => arr.findIndex(
      (x) => x.bitrate === fmt.bitrate && x.protocol === fmt.protocol
    ) === i)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return { videoFormats, audioFormats };
}

function pickBestMergedMp4(info, maxHeight) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const merged = formats.filter(
    (f) => f?.ext === "mp4" && pickUrl(f) && f?.vcodec && f.vcodec !== "none" && f?.acodec && f.acodec !== "none" && f?.height
  );
  if (!merged.length) return null;

  const below = merged.filter((f) => f.height <= maxHeight).sort((a, b) => b.height - a.height)[0];
  if (below) return below;

  return merged.filter((f) => f.height > maxHeight).sort((a, b) => a.height - b.height)[0] || null;
}

// ========= In-flight de-dup =========
const inflight = new Map(); // key: `stream_${id}` -> Promise<{result, client}>

// ========= Fast parallel fetch & merge =========
async function fetchInfoMergedFast(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;

  const all = YT_CLIENTS.map((client) =>
    spawnYtDlpJSON(url, client)
      .then((info) => {
        const fmts = Array.isArray(info?.formats) ? info.formats : [];
        const usable = fmts.some((f) => pickUrl(f));
        if (!usable) throw new Error("No usable formats");
        return { client, info, score: scoreInfo(info) };
      })
  );

  // First good client
  let first;
  try {
    first = await Promise.any(all);
  } catch {
    const bestUrl = await spawnYtDlpBestUrl(url, YT_CLIENTS[0]);
    return {
      info: {
        id,
        formats: [
          {
            format_id: "best",
            ext: bestUrl.includes(".m3u8") ? "m3u8" : "mp4",
            protocol: bestUrl.includes(".m3u8") ? "m3u8" : "https",
            vcodec: "unknown",
            acodec: "unknown",
            url: bestUrl,
          },
        ],
      },
      client: "best-url",
    };
  }

  const gather = Promise.allSettled(all);
  const timed = await Promise.race([
    gather,
    new Promise((r) => setTimeout(() => r("timeout"), FIRST_GOOD_MERGE_WINDOW_MS)),
  ]);

  if (timed === "timeout") {
    return { info: first.info, client: first.client };
  }

  const successes = timed
    .filter((s) => s.status === "fulfilled")
    .map((s) => s.value);

  const merged = mergeInfos(successes.map((t) => t.info));
  const best = successes.sort((a, b) => b.score - a.score)[0];
  return { info: merged, client: best?.client || first.client };
}

// ========= Backpressure helper =========
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
    running,
    queued: queue.length,
    maxYtDlp: MAX_YTDLP,
    cacheKeys: cache.keys().length,
    uptimeSec: Math.floor(process.uptime()),
    rssMB: Math.round(process.memoryUsage().rss / (1024 * 1024)),
  });
});

// Prewarm cache for an ID (use from app when queuing next video)
app.post("/prewarm", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.body?.id || "").trim();
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const cacheKey = `stream_${id}`;
    if (!cache.get(cacheKey)) {
      const { info } = await fetchInfoMergedFast(id);
      cache.set(cacheKey, buildFormats(info), 60);
    }
    setShortPrivate(res, 15);
    res.json({ ok: true });
  } catch (e) {
    console.error("/prewarm error:", e.message);
    res.status(500).json({ error: "Failed to prewarm" });
  }
});

// Formats JSON (short private cache). Uses fast-first + tiny merge window.
app.get("/stream", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.query.id || "").trim().replace(/^\$/, ""); // tolerate accidental leading $
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const cacheKey = `stream_${id}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      res.set("X-PT-Cache", "HIT");
      setShortPrivate(res, 60); // switch to setCacheHeaders(...,"public") if you front with CDN
      return res.json(hit);
    }

    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, (async () => {
        const { info, client } = await fetchInfoMergedFast(id);
        const result = buildFormats(info);
        cache.set(cacheKey, result, 60); // brief; URLs enforce their own expiry
        return { result, client };
      })().finally(() => {
        setTimeout(() => inflight.delete(cacheKey), 0);
      }));
    }

    const { result, client } = await inflight.get(cacheKey);
    res.set("X-PT-Cache", `MISS;client=${client}`);
    setShortPrivate(res, 60);
    res.json(result);
  } catch (e) {
    console.error("/stream error:", e.message);
    res.status(500).json({ error: "Failed to fetch formats" });
  }
});

// Redirect to a merged MP4 close to 480p (uses URL expiry for TTL)
app.get("/stream480", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.query.id || "").trim().replace(/^\$/, "");
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const cacheKey = `stream480_${id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.set("X-PT-Cache", "HIT");
      setCacheHeaders(res, computeUrlTtlSec(cached));
      return res.redirect(cached);
    }

    const { info } = await fetchInfoMergedFast(id);
    const fmt = pickBestMergedMp4(info, 480);
    if (fmt?.url) {
      const ttl = computeUrlTtlSec(fmt.url);
      cache.set(cacheKey, fmt.url, ttl);
      res.set("X-PT-Cache", "MISS");
      setCacheHeaders(res, ttl);
      return res.redirect(fmt.url);
    }

    const url = await spawnYtDlpBestUrl(`https://www.youtube.com/watch?v=${id}`, YT_CLIENTS[0]);
    const ttl = computeUrlTtlSec(url);
    cache.set(cacheKey, url, ttl);
    setCacheHeaders(res, ttl);
    res.redirect(url);
  } catch (e) {
    console.error("/stream480 error:", e.message);
    res.status(500).json({ error: "Failed to pick 480p stream" });
  }
});

// Redirect to best merged MP4 under ?max= (uses URL expiry for TTL)
app.get("/streamMp4", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const id = String(req.query.id || "").trim().replace(/^\$/, "");
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Bad id" });

    const max = Math.max(144, Math.min(2160, parseInt(req.query.max || "720", 10) || 720));
    const cacheKey = `mp4_${max}_${id}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      res.set("X-PT-Cache", "HIT");
      setCacheHeaders(res, computeUrlTtlSec(cached));
      return res.redirect(cached);
    }

    const { info } = await fetchInfoMergedFast(id);
    const fmt = pickBestMergedMp4(info, max);
    if (fmt?.url) {
      const ttl = computeUrlTtlSec(fmt.url);
      cache.set(cacheKey, fmt.url, ttl);
      res.set("X-PT-Cache", "MISS");
      setCacheHeaders(res, ttl);
      return res.redirect(fmt.url);
    }

    const url = await spawnYtDlpBestUrl(`https://www.youtube.com/watch?v=${id}`, YT_CLIENTS[0]);
    const ttl = computeUrlTtlSec(url);
    cache.set(cacheKey, url, ttl);
    setCacheHeaders(res, ttl);
    res.redirect(url);
  } catch (e) {
    console.error("/streamMp4 error:", e.message);
    res.status(502).json({ error: e.message || "Failed to resolve MP4" });
  }
});

// Filter playable shorts (HLS-aware)
app.post("/filterPlayable", async (req, res) => {
  try {
    if (rejectIfBusy(res)) return;
    const items = req.body?.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Invalid input" });

    const ids = Array.from(
      new Set(items.map((it) => it?.id?.videoId).filter((id) => typeof id === "string" && YT_ID.test(id)))
    );

    const tasks = ids.map((id) =>
      schedule(async () => {
        try {
          const { info } = await fetchInfoMergedFast(id);
          const fmts = Array.isArray(info?.formats) ? info.formats : [];
          const hasHls = fmts.some((f) => looksLikeHls(pickUrl(f), f?.protocol, f?.ext));
          if (hasHls) return id; // HLS masters are self-contained for Exo

          const hasVideo = fmts.some((f) => f?.vcodec && f.vcodec !== "none" && pickUrl(f));
          const hasAudio = fmts.some((f) => f?.acodec && f.acodec !== "none" && pickUrl(f));
          return hasVideo && hasAudio ? id : null;
        } catch {
          return null;
        }
      })
    );

    const results = await Promise.all(tasks);
    const playableSet = new Set(results.filter(Boolean));
    const playable = items.filter((it) => playableSet.has(it?.id?.videoId));

    setShortPrivate(res, 60);
    res.json({ playable });
  } catch (e) {
    console.error("/filterPlayable error:", e.message);
    res.status(500).json({ error: "Failed to filter" });
  }
});

// ========= Graceful shutdown =========
process.on("SIGTERM", () => {
  for (const pid of [...children]) { try { process.kill(pid, "SIGKILL"); } catch {} }
  process.exit(0);
});

// ========= Listen =========
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
