"use strict";

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const NodeCache = require("node-cache");
const { spawn } = require("child_process");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json({ limit: "256kb" }));

// ---------- Config ----------
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TTL = Number(process.env.INFO_TTL || 300);            // seconds
const URL_TTL_FALLBACK = Number(process.env.URL_TTL || 300);     // seconds
const MAX_YTDLP = Number(process.env.MAX_YTDLP || 4);
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 45000);
// Comma list of clients to try in order
const YT_CLIENTS = (process.env.YT_CLIENTS || "android,web,tv,ios")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
// Optional cookies file (for age/region)
const YT_COOKIES = process.env.YT_COOKIES;
const HAS_COOKIES = !!(YT_COOKIES && fs.existsSync(YT_COOKIES));

// ---------- Caches ----------
const cache = new NodeCache({ stdTTL: INFO_TTL, useClones: false });
const inFlight = new Map();

// ---------- Concurrency ----------
let running = 0;
const queue = [];
function schedule(fn) {
  return new Promise((resolve, reject) => {
    queue.push(async () => {
      running++;
      try { resolve(await fn()); } catch (e) { reject(e); }
      finally { running--; tick(); }
    });
    tick();
  });
}
function tick() {
  while (running < MAX_YTDLP && queue.length) {
    const job = queue.shift();
    job && job();
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
  } catch (_) {}
  return URL_TTL_FALLBACK;
}

/** Spawn yt-dlp and return parsed JSON. */
function spawnYtDlpJSON(url, playerClient = "android") {
  return schedule(() =>
    new Promise((resolve, reject) => {
      const args = [
        "-J",
        "--no-warnings",
        "--no-progress",
        "--extractor-args", `youtube:player_client=${playerClient}`,
      ];
      if (HAS_COOKIES) { args.push("--cookies", YT_COOKIES); }
      args.push(url);

      const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", c => (out += c));
      child.stderr.on("data", c => (err += c));

      child.on("error", e => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
      child.on("close", code => {
        clearTimeout(timer);
        if (!out && code !== 0) {
          return reject(new Error(`yt-dlp exit ${code}: ${err.split("\n").slice(-6).join(" ")}`));
        }
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`Invalid JSON from yt-dlp: ${e.message}`)); }
      });
    })
  );
}

/** Last-resort: get a single direct URL string via -g -f ... */
function spawnYtDlpBestUrl(url, playerClient = "android") {
  return schedule(() =>
    new Promise((resolve, reject) => {
      const args = [
        "-g",
        "--no-warnings",
        "--no-progress",
        "--extractor-args", `youtube:player_client=${playerClient}`,
        "-f", 'best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best',
      ];
      if (HAS_COOKIES) { args.push("--cookies", YT_COOKIES); }
      args.push(url);

      const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", c => (out += c));
      child.stderr.on("data", c => (err += c));

      child.on("error", e => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
      child.on("close", code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.split("\n").slice(-6).join(" ")}`));
        const url = out.trim().split("\n").pop();
        if (!url) return reject(new Error("No direct URL from yt-dlp -g"));
        resolve(url);
      });
    })
  );
}

/** Try multiple clients and return first JSON with usable formats. */
async function fetchInfoWithFallback(id) {
  const url = `https://www.youtube.com/watch?v=${id}`;
  let lastErr;
  for (const client of YT_CLIENTS) {
    try {
      const info = await spawnYtDlpJSON(url, client);
      const fmts = Array.isArray(info?.formats) ? info.formats : [];
      // Consider usable if we have any URL-ish fields
      const hasUsable = fmts.some(f =>
        f?.url || f?.manifest_url || f?.hls_manifest_url || f?.dash_manifest_url || f?.fragment_base_url
      );
      if (hasUsable) return { info, client };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  // As a last resort, return minimal info with one best URL
  try {
    const bestUrl = await spawnYtDlpBestUrl(url, YT_CLIENTS[0]);
    return {
      info: {
        id,
        formats: [{
          format_id: "best",
          ext: bestUrl.includes(".m3u8") ? "m3u8" : "mp4",
          protocol: bestUrl.includes(".m3u8") ? "m3u8" : "https",
          vcodec: "unknown",
          acodec: "unknown",
          url: bestUrl,
        }]
      },
      client: "best-url"
    };
  } catch (e) {
    throw lastErr || e;
  }
}

function buildFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const pickUrl = (f) =>
    f?.url ||
    f?.manifest_url ||
    f?.hls_manifest_url ||
    f?.dash_manifest_url ||
    f?.fragment_base_url ||
    null;

  const isStoryboard = (f) =>
    f?.protocol === "mhtml" || /^sb\d/.test(String(f?.format_id || ""));

  const looksLikeHls = (url, proto, ext) =>
    (typeof proto === "string" && proto.includes("m3u8")) ||
    (typeof ext === "string" && ext.includes("m3u8")) ||
    (typeof url === "string" && url.includes(".m3u8"));

  const videoFormats = formats
    .filter((f) => !isStoryboard(f))
    .filter((f) =>
      // keep adaptive video or anything that looks like a playable HLS/DASH entry
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
        // HLS master/variant should be considered self-contained for ExoPlayer
        has_audio: hls ? true : !!(f?.acodec && f.acodec !== "none"),
        bandwidth: f?.tbr || f?.abr || null,
        url,
      };
    })
    .filter((fmt) => fmt.url)
    .filter(
      (fmt, i, arr) =>
        arr.findIndex(
          (x) => x.resolution === fmt.resolution && x.protocol === fmt.protocol
        ) === i
    )
    .sort((a, b) => a.height - b.height);

  const audioFormats = formats
    .filter((f) => !isStoryboard(f))
    .filter((f) => (!f?.vcodec || f.vcodec === "none") && f?.acodec && f.acodec !== "none")
    .map((f) => ({
      format_id: f?.format_id,
      extension: f?.ext || "m4a",
      protocol: f?.protocol || "https",
      bitrate: f?.abr || f?.tbr || null,
      url: pickUrl(f),
    ))
    .filter((fmt) => fmt.url)
    .filter(
      (fmt, i, arr) =>
        arr.findIndex(
          (x) => x.bitrate === fmt.bitrate && x.protocol === fmt.protocol
        ) === i
    )
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return { videoFormats, audioFormats };
}
function pickBestMergedMp4(info, maxHeight) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const pickUrl = (f) =>
    f?.url || f?.manifest_url || f?.hls_manifest_url || f?.dash_manifest_url || f?.fragment_base_url || null;

  const merged = formats.filter(f =>
    f?.ext === "mp4" &&
    pickUrl(f) &&
    f?.vcodec && f.vcodec !== "none" &&
    f?.acodec && f.acodec !== "none" &&
    f?.height
  );
  if (!merged.length) return null;

  const below = merged.filter(f => f.height <= maxHeight).sort((a, b) => b.height - a.height)[0];
  if (below) return below;
  return merged.filter(f => f.height > maxHeight).sort((a, b) => a.height - b.height)[0] || null;
}

// ---------- Routes ----------

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, running, queued: queue.length, cacheKeys: cache.keys().length });
});

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

    const { info, client } = await fetchInfoWithFallback(id);
    const result = buildFormats(info);

    cache.set(cacheKey, result, 60);
    res.set("X-PT-Cache", `MISS;client=${client}`);
    setShortPrivate(res, 60);
    res.json(result);
  } catch (e) {
    console.error("/stream error:", e.message);
    res.status(500).json({ error: "Failed to fetch formats" });
  }
});

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

    const { info } = await fetchInfoWithFallback(id);
    const fmt = pickBestMergedMp4(info, 480);
    if (fmt?.url) {
      const ttl = computeUrlTtlSec(fmt.url);
      cache.set(cacheKey, fmt.url, ttl);
      res.set("X-PT-Cache", "MISS");
      setCacheHeaders(res, ttl);
      return res.redirect(fmt.url);
    }

    // If no merged MP4, fallback to best URL
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

    const { info } = await fetchInfoWithFallback(id);
    const fmt = pickBestMergedMp4(info, max);
    if (fmt?.url) {
      const ttl = computeUrlTtlSec(fmt.url);
      cache.set(cacheKey, fmt.url, ttl);
      res.set("X-PT-Cache", "MISS");
      setCacheHeaders(res, ttl);
      return res.redirect(fmt.url);
    }

    // Fallback
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

app.post("/filterPlayable", async (req, res) => {
  try {
    const items = req.body?.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: "Invalid input" });

    const ids = Array.from(new Set(items
      .map(it => it?.id?.videoId)
      .filter(id => typeof id === "string" && YT_ID.test(id))
    ));

    const results = await Promise.all(ids.map(id =>
      schedule(async () => {
        try {
          const { info } = await fetchInfoWithFallback(id);
          const fmts = Array.isArray(info?.formats) ? info.formats : [];
          const hasVideo = fmts.some(f => (f?.ext === "mp4" || f?.manifest_url || f?.hls_manifest_url) && f?.vcodec && f.vcodec !== "none");
          const hasAudio = fmts.some(f => f?.acodec && f.acodec !== "none");
          return hasVideo && hasAudio ? id : null;
        } catch { return null; }
      })
    ));

    const playableSet = new Set(results.filter(Boolean));
    const playable = items.filter(it => playableSet.has(it?.id?.videoId));

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
