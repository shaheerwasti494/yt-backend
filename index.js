// server.js
const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  const cmd = `yt-dlp -J "https://www.youtube.com/watch?v=${id}"`;
  exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
    if (err) {
      console.error("yt-dlp error:", err);
      return res.status(500).json({ error: "Failed to fetch formats" });
    }

    let info;
    try {
      info = JSON.parse(stdout);
    } catch (e) {
      console.error("JSON parse error:", e);
      return res.status(500).json({ error: "Invalid JSON from yt-dlp" });
    }

    const formats = info.formats || [];

    // Only progressive MP4 formats (video + audio)
    const progressiveMp4s = formats
      .filter(f =>
        f.vcodec && f.vcodec !== "none" &&
        f.acodec && f.acodec !== "none" &&
        f.ext === "mp4" &&
        f.protocol === "https"      // exclude HLS/DASH
      )
      .map(f => ({
        format_id:  f.format_id,
        resolution: f.height ? `${f.height}p` : "unknown",
        fps:        f.fps || null,
        bandwidth:  f.tbr || null,
        url:        f.url
      }))
      // dedupe by resolution
      .filter((fmt, i, arr) =>
        arr.findIndex(x => x.resolution === fmt.resolution) === i
      )
      // sort ascending
      .sort((a, b) => {
        const ra = parseInt(a.resolution) || 0;
        const rb = parseInt(b.resolution) || 0;
        return ra - rb;
      });

    if (!progressiveMp4s.length) {
      return res.status(404).json({ error: "No progressive MP4 formats found" });
    }

    res.json({ videoFormats: progressiveMp4s });
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
