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

  // 1) Get full metadata
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

    // 2) Build videoFormats array
    const videoFormats = formats
      .filter(f =>
        f.vcodec && f.vcodec !== "none" && f.ext === "mp4" ||
        f.vcodec && f.vcodec !== "none" && f.ext === "webm"
      )
      .map(f => ({
        format_id:  f.format_id,
        extension:  f.ext,
        resolution: f.height ? `${f.height}p` : "audio-only",
        fps:        f.fps || null,
        has_audio:  !!f.acodec && f.acodec !== "none",
        vcodec:     f.vcodec,
        acodec:     f.acodec || null,
        bandwidth:  f.tbr || null,
        url:        f.url
      }))
      // dedupe by resolution+ext+has_audio to avoid exact duplicates
      .filter((fmt, i, arr) =>
        arr.findIndex(x =>
          x.resolution === fmt.resolution &&
          x.extension  === fmt.extension &&
          x.has_audio  === fmt.has_audio
        ) === i
      );

    // 3) Build audioFormats array
    const audioFormats = formats
      .filter(f =>
        (!f.vcodec || f.vcodec === "none") &&
        f.acodec && f.acodec !== "none"
      )
      .map(f => ({
        format_id: f.format_id,
        extension: f.ext,
        acodec:    f.acodec,
        bandwidth: f.abr || null,
        url:       f.url
      }))
      // dedupe by bitrate+ext
      .filter((fmt, i, arr) =>
        arr.findIndex(x =>
          x.bandwidth === fmt.bandwidth &&
          x.extension === fmt.extension
        ) === i
      )
      // sort descending by bitrate
      .sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));

    if (!videoFormats.length && !audioFormats.length) {
      return res.status(404).json({ error: "No formats found" });
    }

    // 4) Send everything to the client
    res.json({
      videoFormats,
      audioFormats
    });
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
