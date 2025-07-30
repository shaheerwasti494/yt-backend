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

  // 1) Fetch full JSON metadata
  const cmd = `yt-dlp -J "https://www.youtube.com/watch?v=${id}"`;

  exec(cmd, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
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

    // 2) Collect all MP4 AVC video streams
    const videoFormats = formats
      .filter(f =>
        f.ext === "mp4" &&
        f.vcodec && f.vcodec.includes("avc") &&
        f.width && f.height
      )
      // map to normalized objects
      .map(f => ({
        format_id: f.format_id,
        resolution: `${f.height}p`,
        url: f.url,
        has_audio: !!f.acodec && f.acodec !== "none"
      }))
      // dedupe by resolution, keep first occurrence
      .filter((fmt, idx, arr) =>
        arr.findIndex(x => x.resolution === fmt.resolution) === idx
      );

    // 3) Pick best AAC audio-only stream
    const audioFormatObj = formats.find(f =>
      f.ext === "m4a" &&
      f.acodec && f.acodec.includes("mp4a")
    );
    const audioFormat = audioFormatObj ? audioFormatObj.url : null;

    if (videoFormats.length === 0) {
      return res.status(404).json({ error: "No video formats found" });
    }

    // 4) Send JSON
    res.json({ videoFormats, audioFormat });
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
