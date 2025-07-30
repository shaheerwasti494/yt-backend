const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) {
    return res.status(400).json({ error: "Missing video ID" });
  }

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

    // ✅ Include both progressive and adaptive formats
    const allFormats = formats
      .filter(f =>
        f.vcodec && f.vcodec !== "none" &&
        (f.ext === "mp4" || f.ext === "webm") &&
        f.protocol !== "m3u8" && // exclude HLS playlists
        f.protocol !== "dash"   // exclude DASH manifests (we provide direct URLs)
      )
      .map(f => ({
        format_id:  f.format_id,
        extension:  f.ext,
        resolution: f.height ? `${f.height}p` : "unknown",
        fps:        f.fps || null,
        vcodec:     f.vcodec,
        acodec:     f.acodec && f.acodec !== "none" ? f.acodec : null,
        bandwidth:  f.tbr || null,
        url:        f.url,
        has_audio:  f.acodec && f.acodec !== "none"
      }))
      // avoid duplicate resolutions
      .filter((fmt, i, arr) =>
        arr.findIndex(x =>
          x.resolution === fmt.resolution &&
          x.extension === fmt.extension
        ) === i
      )
      // sort by height (ascending)
      .sort((a, b) => parseInt(a.resolution) - parseInt(b.resolution));

    if (!allFormats.length) {
      return res.status(404).json({ error: "No video formats found" });
    }

    res.json({
      videoFormats: allFormats
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
