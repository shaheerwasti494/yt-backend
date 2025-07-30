const express = require("express");
const { exec }  = require("child_process");
const cors      = require("cors");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/stream", (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: "Missing video ID" });

  const cmd = `yt-dlp -J "https://www.youtube.com/watch?v=${id}"`;

  exec(cmd, { maxBuffer: 15 * 1024 * 1024 }, (err, stdout) => {
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

    // 🎥 Video formats (MP4, AVC)
    const videoFormats = formats
      .filter(f =>
        f.ext === "mp4" &&
        f.vcodec && f.vcodec.includes("avc") &&
        f.width && f.height // ensures it's a video
      )
      .map(f => ({
        format_id: f.format_id,
        resolution: `${f.height}p`,
        url: f.url,
        has_audio: !!f.acodec && f.acodec !== "none",
        has_video: !!f.vcodec && f.vcodec !== "none"
      }));

    // 🔊 Best audio-only stream (AAC)
    const audioFormat = formats.find(f =>
      f.ext === "m4a" &&
      f.acodec && f.acodec.includes("mp4a")
    );

    if (videoFormats.length === 0) {
      return res.status(404).json({ error: "No video formats found" });
    }

    res.json({
      videoFormats,
      audioFormat: audioFormat ? {
        format_id: audioFormat.format_id,
        url: audioFormat.url
      } : null
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
