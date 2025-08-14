"use strict";

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const NodeCache = require("node-cache");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json({ limit: "256kb" }));

// ---------- Config ----------
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TTL = Number(process.env.INFO_TTL || 300);        // seconds (info cache)
const URL_TTL_FALLBACK = Number(process.env.URL_TTL || 300); // seconds (URL cache)
const MAX_YTDLP = Number(process.env.MAX_YTDLP || 4);
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 45000);

// Prefer android/tv for quick-start HLS; still merge others opportunistically
const YT_CLIENTS = (process.env.YT_CLIENTS || "android,tv,web,ios")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Return the first good client immediately, but wait this long (ms) to merge late arrivals (optional)
const FIRST_GOOD_MERGE_WINDOW_MS = Number(process.env.FIRST_GOOD_MERGE_WINDOW_MS || 250);

// ---------- Cookies (Path A: file or base64) ----------
let YT_COOKIES = process.env.YT_COOKIES || "";
if (process.env.YT_COOKIES_B64) {
  try {
    const tmpFile = path.join(os.tmpdir(), "youtube.cookies.txt");
    require("fs").writeFileSync(tmpFile, Buffer.from(process.env.YT_COOKIES_B64, "base64"));
    YT_COOKIES = tmpFile;
  } catch (e) {
    console.error("Failed to write YT_COOKIES_B64:", e.message);
  }
}
const HAS_COOKIES = !!(YT_COOKIES && require("fs").existsSync(YT_COOKIES));

if (HAS_COOKIES) {
  try {
    const stat = require("fs").statSync(YT_COOKIES);
    console.log(`✅ Cookies loaded (${stat.size} bytes) from: ${YT_COOKIES}`);
  } catch {
    console.warn("⚠️ Cookies path set but unreadable");
  }
} else {
  console.warn("⚠️ No cookies found. Age/region/anti-bot checks may fail.`);
}

// ---------- Caches ----------
const cache = new NodeCache({ stdTTL: INFO_TTL, useClones: false });

// ---------- Concurrency (semaphore) ----------
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

// ---------- Helpers ----------
const YT_ID = /^[\w-]{11}$/;

function setCacheHeaders(res, seconds, extra = "public") {
  res.set("Cache-Control", `${extra}, max-age=${seconds}, s-maxage=${seconds}`);
}
function setShortPrivate(res, seconds = 60) {
  res.set("Cache-Control", `private, max-age=${seconds}`);
}

/** Parse 'expire' from googlevideo-style URLs for adaptive TTL. */
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

/** Heuristic to pick the “best” info (bigger max height + more adaptive tracks). */
function scoreInfo(info) {
  const fmts = Array.isArray(info?.formats) ? info.formats : [];
  const maxH = fmts.reduce((m, f) => Math.max(m, Number(f?.height) || 0), 0);
  const adaptiveCount = fmts.filter(
    (f) => (f?.vcodec && f.vcodec !== "none") && (!f?.acodec || f.acodec === "none")
  ).length;
  return maxH * 1000 + adaptiveCount;
}

/** Merge multiple infos’ formats into a superset (dedup roughly). */
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

/** yt-dlp JSON */
function spawnYtDlpJSON(url, playerClient = "android") {
  return schedule(
    () =>
      new Promise((resolve, reject) => {
        const args = [
          "-J",
          "--no-warnings",
          "--no-progress",
          "--extractor-args",
          `youtube:player_client=${playerClient}`,
        ];
        if (HAS_COOKIES) {
          args.push("--cookies", YT_COOKIES);
        }
        args.push(url);

        const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
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

/** Single best URL fallback */
function spawnYtDlpBestUrl(url, playerClient = "android") {
  return schedule(
    () =>
      new Promise((resolve, reject) => {
        const args = [
          "-g",
          "--no-warnings",
          "--no-progress",
          "--extractor-args",
          `youtube:player_client=${playerClient}`,
          "-f",
          'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',
        ];
        if (HAS_COOKIES) args.push("--cookies", YT_COOKIES);
        args.push(url);

        const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
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

/** Build normalized ladder */
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
    // keep both progressive and HLS at each height
    .filter((fmt, i, arr) => arr.findIndex(
      (x) => x.resolution === fmt.resolution && x.protocol === fmt.protocol
    ) === i)
    .sort((a, b) => a.height - b.height);

  const audioFormats = formats
    .filter((f) => !isStoryboard(f))
    .filter((f) => (!f?.vcodec || f?.vcodec === "none") && f?.acodec && f?.acodec !== "none")
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

/** Best merged MP4 under limit */
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

// ---------- In-flight de-dup (coalesce) ----------
const inflight = new Map(); // key: `stream_${id}` -> Promise<{videoFormats,audioFormats}>

// ---------- Fast parallel fetch & merge ----------
async function fetchInfoMergedFast(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;

  // Start all clients in parallel
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
    // none succeeded; last resort: best url from first client name
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

  // Optionally wait a short window to gather more results to merge
  const gather = Promise.allSettled(all);
  const timed = await Promise.race([
    gather,
    new Promise((r) => setTimeout(() => r("timeout"), FIRST_GOOD_MERGE_WINDOW_MS)),
  ]);

  if (timed === "timeout") {
    // Just return first (fast path)
    return { info: first.info, client: first.client };
  }

  // Merge everything that succeeded
  const successes = /** @type {Array<{value?: any, status: string}>} */ (timed)
    .filter((s) => s.status === "fulfilled")
    .map((s) => s.value);

  const merged = mergeInfos(successes.map((t) => t.info));
  // Pick best client label for logging
  const best = successes.sort((a, b) => b.score - a.score)[0];
  return { info: merged, client: best?.client || first.client };
}

// ---------- Routes ----------

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, running, queued: queue.length, cacheKeys: cache.keys().length });
});

// Prewarm cache for an ID (use from app when queuing next video)
app.post("/prewarm", async (req, res) => {
  try {
    const id = String(req.body?.id || "");
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
    const id = String(req.query.id || "");
    if (!YT_ID.test(id)) return res.status(400).json({ error: "Missing/invalid video ID" });

    const cacheKey = `stream_${id}`;
    const hit = cache.get(cacheKey);
    if (hit) {
      res.set("X-PT-Cache", "HIT");
      setShortPrivate(res, 60);
      return res.json(hit);
    }

    // In-flight coalescing
    if (!inflight.has(cacheKey)) {
      inflight.set(cacheKey, (async () => {
        const { info, client } = await fetchInfoMergedFast(id);
        const result = buildFormats(info);
        // cache briefly; URLs will be revalidated by their own expiry anyway
        cache.set(cacheKey, result, 60);
        return { result, client };
      })().finally(() => {
        // remove after it resolves (allow next miss to refresh)
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
    const id = String(req.query.id || "");
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
    const id = String(req.query.id || "");
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

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
