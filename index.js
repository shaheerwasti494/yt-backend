"use strict";

const express = require("express");
const cors = require("cors");
const compression = require("compression");
const NodeCache = require("node-cache");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(compression());
app.use(express.json({ limit: "256kb" })); // for /filterPlayable

// ---------- Config ----------
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const INFO_TTL = Number(process.env.INFO_TTL || 300);   // seconds
const URL_TTL_FALLBACK = Number(process.env.URL_TTL || 300);
const MAX_YTDLP = Number(process.env.MAX_YTDLP || 4);
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS || 45000);

// ---------- Caches ----------
const cache = new NodeCache({ stdTTL: INFO_TTL, useClones: false });
const inFlight = new Map(); // de-dupe concurrent fetches

// ---------- Simple semaphore ----------
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

/** Parse 'expire' (epoch seconds) from googlevideo URL → remaining TTL in seconds. */
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

function spawnYtDlpJSON(url) {
  return schedule(() =>
    new Promise((resolve, reject) => {
      const args = [
        "-J",
        "--no-warnings",
        "--no-progress",
        // Use Android player client for URLs that work well with Exo
        "--extractor-args", "youtube:player_client=android",
        url
      ];
      const child = spawn(YTDLP_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, YTDLP_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", c => out += c);
      child.stderr.on("data", c => err += c);

      child.on("error", e => { clearTimeout(timer); reject(new Error(`yt-dlp spawn error: ${e.message}`)); });
      child.on("close", code => {
        clearTimeout(timer);
        if (!out && code !== 0) return reject(new Error(`yt-dlp exit ${code}: ${err.split("\n").slice(-4).join(" ")}`));
        try { resolve(JSON.parse(out)); }
        catch (e) { reject(new Error(`Invalid JSON from yt-dlp: ${e.message}`)); }
      });
    })
  );
}

/** Get yt-dlp info with cache + in-flight de-dup */
async function getVideoInfo(id) {
  const key = `info_${id}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (inFlight.has(key)) return inFlight.get(key);

  const p = (async () => {
    const url = `https://www.youtube.com/watch?v=${id}`;
    const info = await spawnYtDlpJSON(url);
    cache.set(key, info, INFO_TTL);
    return info;
  })();

  inFlight.set(key, p);
  try { return await p; } finally { inFlight.delete(key); }
}

/** Format lists from yt-dlp JSON */
function buildFormats(info) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];

  const videoFormats = formats
    .filter(f => f?.vcodec && f.vcodec !== "none")
    .map(f => ({
      format_id: f.format_id,
      extension: f.ext,
      resolution: f.height ? `${f.height}p` : "unknown",
      height: f.height || 0,
      protocol: f.protocol || null,
      has_audio: !!(f.acodec && f.acodec !== "none"),
      bandwidth: f.tbr || f.abr || null,
      url: f.url || null
    }))
    .filter(fmt => fmt.url)
    .filter((fmt, i, arr) =>
      arr.findIndex(x => x.resolution === fmt.resolution && x.protocol === fmt.protocol) === i
    )
    .sort((a, b) => a.height - b.height);

  const audioFormats = formats
    .filter(f => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
    .map(f => ({
      format_id: f.format_id,
      extension: f.ext,
      protocol: f.protocol || null,
      bitrate: f.abr || f.tbr || null,
      url: f.url || null
    }))
    .filter(fmt => fmt.url)
    .filter((fmt, i, arr) =>
      arr.findIndex(x => x.bitrate === fmt.bitrate && x.protocol === fmt.protocol) === i
    )
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  return { videoFormats, audioFormats };
}

function pickBestMergedMp4(info, maxHeight) {
  const formats = Array.isArray(info?.formats) ? info.formats : [];
  const merged = formats.filter(f =>
    f?.ext === "mp4" &&
    f?.url &&
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

// Return JSON with formats (short-cache so URLs stay fresh)
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

    const info = await getVideoInfo(id);
    const result = buildFormats(info);

    cache.set(cacheKey, result, 60); // keep internal copy for a minute
    res.set("X-PT-Cache", "MISS");
    setShortPrivate(res, 60);
    res.json(result);
  } catch (e) {
    console.error("/stream error:", e.message);
    res.status(500).json({ error: "Failed to fetch formats" });
  }
});

// Redirect to a merged MP4 close to 480p (use URL's own expiry for TTL)
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

    const info = await getVideoInfo(id);
    const fmt = pickBestMergedMp4(info, 480);
    if (!fmt?.url) return res.status(404).json({ error: "No suitable merged MP4 found" });

    const ttl = computeUrlTtlSec(fmt.url);
    cache.set(cacheKey, fmt.url, ttl);
    res.set("X-PT-Cache", "MISS");
    setCacheHeaders(res, ttl);
    res.redirect(fmt.url);
  } catch (e) {
    console.error("/stream480 error:", e.message);
    res.status(500).json({ error: "Failed to pick 480p stream" });
  }
});

// Redirect to best merged MP4 under ?max=
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

    const info = await getVideoInfo(id);
    const fmt = pickBestMergedMp4(info, max);
    if (!fmt?.url) return res.status(404).json({ error: "No MP4 with audio found" });

    const ttl = computeUrlTtlSec(fmt.url);
    cache.set(cacheKey, fmt.url, ttl);
    res.set("X-PT-Cache", "MISS");
    setCacheHeaders(res, ttl);
    res.redirect(fmt.url);
  } catch (e) {
    console.error("/streamMp4 error:", e.message);
    res.status(502).json({ error: e.message || "Failed to resolve MP4" });
  }
});

// Filter playable shorts (reuses info cache; throttled by semaphore)
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
          const info = await getVideoInfo(id);
          const fmts = Array.isArray(info?.formats) ? info.formats : [];
          const hasVideo = fmts.some(f => f?.ext === "mp4" && f?.vcodec && f.vcodec !== "none" && f?.height && f.height <= 480 && f?.url);
          const hasAudio = fmts.some(f => f?.acodec && f.acodec !== "none" && f?.url);
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
