const express = require("express");
const { exec }  = require("child_process");
const cors      = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  // 1) dump full info as JSON
  const cmd = `yt-dlp -J "https://www.youtube.com/watch?v=${id}"`;

  exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
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

    // 2) filter for MP4 with AVC video + AAC audio
    const choices = (info.formats || [])
      .filter(f =>
        f.ext === "mp4"
        && f.vcodec  && f.vcodec.includes("avc")
        && f.acodec && f.acodec.includes("mp4a")
        && f.width && f.height // ensure it’s video+audio
      )
      // 3) map to only the fields you need
      .map(f => ({
        format_id:  f.format_id,
        resolution: `${f.height}p`,
        url:        f.url
      }));

    if (choices.length === 0) {
      return res.status(404).json({ error: "No suitable MP4 formats found" });
    }

    // return array of qualities
    res.json({ formats: choices });
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
