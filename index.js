const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());

app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  // Get full metadata JSON from yt-dlp
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

    // 1) All video formats (progressive + adaptive)
    const videoFormats = formats
      .filter(f => f.vcodec && f.vcodec !== "none")             // has video
      .map(f => ({
        format_id:  f.format_id,
        extension:  f.ext,
        resolution: f.height ? `${f.height}p` : "audio-only",
        protocol:   f.protocol,                                   // https, dash, m3u8_native
        has_audio:  !!(f.acodec && f.acodec !== "none"),
        bandwidth:  f.tbr || f.abr || null,
        url:        f.url
      }))
      // de‑dupe identical resolution+protocol
      .filter((fmt, i, arr) =>
        arr.findIndex(x =>
          x.resolution === fmt.resolution &&
          x.protocol   === fmt.protocol
        ) === i
      )
      .sort((a, b) => {
        // sort by numeric resolution then protocol
        const ra = parseInt(a.resolution) || 0;
        const rb = parseInt(b.resolution) || 0;
        if (ra !== rb) return ra - rb;
        return a.protocol.localeCompare(b.protocol);
      });

    // 2) All audio‑only formats
    const audioFormats = formats
      .filter(f => (!f.vcodec || f.vcodec === "none") && f.acodec && f.acodec !== "none")
      .map(f => ({
        format_id: f.format_id,
        extension: f.ext,
        protocol:  f.protocol,
        bitrate:   f.abr || null,
        url:       f.url
      }))
      .filter((fmt, i, arr) =>
        arr.findIndex(x =>
          x.bitrate === fmt.bitrate &&
          x.protocol === fmt.protocol
        ) === i
      )
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (!videoFormats.length) {
      return res.status(404).json({ error: "No video formats found" });
    }

    res.json({ videoFormats, audioFormats });
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
