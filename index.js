// server.js
const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Create cache with 5 minute TTL
const cache = new NodeCache({ stdTTL: 300 });

// ------------------ /stream endpoint (JSON) ------------------
app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  // Check cache
  const cached = cache.get(`stream_${id}`);
  if (cached) {
    console.log(`Cache hit for /stream ${id}`);
    return res.json(cached);
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const cmd = `yt-dlp -J "${url}"`;

  exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) {
      console.error("yt-dlp error:", err || "no output");
      return res.status(500).json({ error: "Failed to fetch formats" });
    }

    let info;
    try {
      info = JSON.parse(stdout);
    } catch (e) {
      console.error("JSON parse error:", e.message);
      return res.status(500).json({ error: "Invalid JSON from yt-dlp" });
    }

    const formats = info.formats || [];

    const videoFormats = formats
      .filter(f => f.vcodec && f.vcodec !== "none")
      .map(f => ({
        format_id: f.format_id,
        extension: f.ext,
        resolution: f.height ? `${f.height}p` : "audio-only",
        protocol: f.protocol,
        has_audio: !!(f.acodec && f.acodec !== "none"),
        bandwidth: f.tbr || f.abr || null,
        url: f.url
      }))
      .filter((fmt, i, arr) =>
        arr.findIndex(x => x.resolution === fmt.resolution && x.protocol === fmt.protocol) === i
      )
      .sort((a, b) => {
        const ra = parseInt(a.resolution) || 0;
        const rb = parseInt(b.resolution) || 0;
        return ra - rb;
      });

    const audioFormats = formats
      .filter(f => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
      .map(f => ({
        format_id: f.format_id,
        extension: f.ext,
        protocol: f.protocol,
        bitrate: f.abr || null,
        url: f.url
      }))
      .filter((fmt, i, arr) =>
        arr.findIndex(x => x.bitrate === fmt.bitrate && x.protocol === fmt.protocol) === i
      )
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    const result = { videoFormats, audioFormats };
    cache.set(`stream_${id}`, result); // Cache it
    res.json(result);
  });
});

// ------------------ /stream480 endpoint (480p + audio+video only) ------------------
app.get("/stream480", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  const cacheKey = `stream480_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`Cache hit for /stream480 ${id}`);
    return res.redirect(cached);
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const cmd = `yt-dlp -J "${url}"`;

  exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) {
      console.error("yt-dlp error:", err || "no output");
      return res.status(500).json({ error: "Failed to fetch formats" });
    }

    let info;
    try {
      info = JSON.parse(stdout);
    } catch (e) {
      console.error("JSON parse error:", e.message);
      return res.status(500).json({ error: "Invalid JSON from yt-dlp" });
    }

    const merged = (info.formats || [])
      .filter(f =>
        f.ext === "mp4" &&
        f.vcodec && f.vcodec !== "none" &&
        f.acodec && f.acodec !== "none" &&
        f.height
      );

    if (!merged.length) {
      return res.status(404).json({ error: "No merged (audio+video) MP4 found" });
    }

    // Try to find exactly 480p or closest below it
    let format = merged
      .filter(f => f.height <= 480)
      .sort((a, b) => b.height - a.height)[0];

    // If not found, use the lowest available above 480p
    if (!format) {
      format = merged
        .filter(f => f.height > 480)
        .sort((a, b) => a.height - b.height)[0];
    }

    if (!format || !format.url) {
      return res.status(404).json({ error: "No suitable format found" });
    }

    console.log(`✅ Redirecting to ${format.height}p merged MP4`);
    cache.set(cacheKey, format.url); // cache the final URL
    res.redirect(format.url);
  });
});
// ------------------ /streamMp4 endpoint (Fast 480p+audio MP4 using yt-dlp -g) ------------------
app.get("/streamMp4", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  const cacheKey = `streamMp4_${id}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    console.log(`Cache hit for /streamMp4 ${id}`);
    return res.redirect(cached);
  }

  const url = `https://www.youtube.com/watch?v=${id}`;
  const cmd = `yt-dlp -f "bestvideo[height<=480][ext=mp4][vcodec!=none][acodec!=none]" -g "${url}"`;

  exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) {
      console.error("yt-dlp error:", err || "no output");
      return res.status(500).json({ error: "Failed to fetch playable stream" });
    }

    const finalUrl = stdout.trim().split('\n').pop();
    if (!finalUrl) {
      return res.status(404).json({ error: "Playable MP4 format not found" });
    }

    console.log(`✅ /streamMp4 redirecting to: ${finalUrl}`);
    cache.set(cacheKey, finalUrl);
    res.redirect(finalUrl);
  });
});

// ---------- /filterPlayable - filters playable shorts ----------
const pLimit = require("p-limit"); // At the top of server.js if not already

app.post("/filterPlayable", express.json(), async (req, res) => {
  const items = req.body.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid input" });
  }

  console.log(`🔍 Checking playability for ${items.length} shorts`);

  const limit = pLimit(3); // Run max 3 at a time

  const results = await Promise.allSettled(
    items.map(item =>
      limit(async () => {
        const id = item?.id?.videoId;
        if (!id) return null;

        try {
          const cmd = `yt-dlp -J "https://www.youtube.com/watch?v=${id}"`;
          const { stdout } = await execPromise(cmd);

          const info = JSON.parse(stdout);
          const hasVideo = (info.formats || []).some(f =>
            f.ext === "mp4" &&
            f.vcodec && f.vcodec !== "none" &&
            f.height && f.height <= 480
          );
          const hasAudio = (info.formats || []).some(f =>
            f.acodec && f.acodec !== "none"
          );

          const playable = hasVideo && hasAudio;
          if (!playable) {
            console.log(`🚫 Not playable: ${id}`);
          }

          return playable ? item : null;
        } catch (err) {
          console.error(`❌ yt-dlp error for ${id}:`, err.message);
          return null;
        }
      })
    )
  );

  const filtered = results
    .filter(r => r.status === "fulfilled" && r.value !== null)
    .map(r => r.value);

  console.log(`✅ ${filtered.length} shorts are playable`);
  res.json({ playable: filtered });
});


const util = require("util");
const execPromise = (cmd) => {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve({ stdout });
    });
  });
};

// ------------------ Start Server ------------------
app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});

is this correct?