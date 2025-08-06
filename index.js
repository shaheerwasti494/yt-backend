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

// ------------------ /streamMp4 endpoint (Redirect) ------------------
app.get("/streamMp4", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  const cached = cache.get(`streamMp4_${id}`);
  if (cached) {
    console.log(`Cache hit for /streamMp4 ${id}`);
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

    const mp4s = (info.formats || [])
      .filter(f => f.ext === "mp4" && f.vcodec && f.vcodec !== "none")
      .map(f => ({
        url: f.url,
        height: f.height || 0,
        hasAudio: !!(f.acodec && f.acodec !== "none")
      }));

    if (!mp4s.length) {
      return res.status(404).json({ error: "No MP4 formats found" });
    }

    let chosen = mp4s
      .filter(x => x.height <= 360)
      .sort((a, b) => b.height - a.height)[0] || mp4s.sort((a, b) => b.height - a.height)[0];

    console.log(`Redirecting to ${chosen.height}p MP4 (hasAudio=${chosen.hasAudio})`);
    cache.set(`streamMp4_${id}`, chosen.url); // Cache redirect URL
    res.redirect(chosen.url);
  });
});

// ------------------ Start Server ------------------
app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});