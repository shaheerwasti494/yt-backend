// server.js
const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const NodeCache = require("node-cache");
const util = require("util");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

const cache = new NodeCache({ stdTTL: 300 }); // 5 min cache

// Helper: promisified exec
const execPromise = (cmd) => {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 45000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve({ stdout });
    });
  });
};

// ------------------ /stream ------------------
app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

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
    cache.set(`stream_${id}`, result);
    res.json(result);
  });
});

// ------------------ /stream480 ------------------
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

    let format = merged.filter(f => f.height <= 480).sort((a, b) => b.height - a.height)[0];
    if (!format) {
      format = merged.filter(f => f.height > 480).sort((a, b) => a.height - b.height)[0];
    }

    if (!format || !format.url) {
      return res.status(404).json({ error: "No suitable format found" });
    }

    console.log(`✅ Redirecting to ${format.height}p merged MP4`);
    cache.set(cacheKey, format.url);
    res.redirect(format.url);
  });
});

// ------------------ /streamMp4 ------------------
app.get("/streamMp4", async (req, res) => {
  const { id, max = 720 } = req.query;
  if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: "Bad id" });

  const cacheKey = `mp4_${max}_${id}`;
  if (cache.has(cacheKey)) return res.redirect(cache.get(cacheKey));

  try {
    const url = `https://www.youtube.com/watch?v=${id}`;
    const { stdout } = await execPromise(
      `yt-dlp -f "best[ext=mp4][height<=${max}][vcodec!=none][acodec!=none]/best[ext=mp4]" -g "${url}"`
    );
    const direct = stdout.trim().split("\n").pop();
    if (!direct) throw new Error("No MP4");

    cache.set(cacheKey, direct);
    res.redirect(direct);          // 302 by default, good for ExoPlayer
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});


// ------------------ /filterPlayable ------------------
app.post("/filterPlayable", express.json(), async (req, res) => {
  // ✅ Dynamic import only inside async function
  const pLimit = (await import("p-limit")).default;

  const items = req.body.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: "Invalid input" });
  }

  console.log(`🔍 Checking playability for ${items.length} shorts`);
  const limit = pLimit(3);

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

          return hasVideo && hasAudio ? item : null;
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

// ------------------ Start Server ------------------
app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
