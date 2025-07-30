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

    // 1) Video formats (progressive + adaptive)
    const videoFormats = formats
      .filter(f =>
        f.vcodec && f.vcodec !== "none" &&
        (f.ext === "mp4" || f.ext === "webm") // keep mp4/webm
      )
      .map(f => ({
        format_id:  f.format_id,
        extension:  f.ext,
        resolution: f.height ? `${f.height}p` : "audio-only",
        protocol:   f.protocol,           // e.g. "https", "m3u8_native", "dash"
        has_audio:  !!(f.acodec && f.acodec !== "none"),
        bandwidth:  f.tbr || f.abr || null,
        url:        f.url
      }))
      .filter((fmt, i, arr) =>
        arr.findIndex(x =>
          x.resolution === fmt.resolution &&
          x.extension  === fmt.extension &&
          x.protocol   === fmt.protocol
        ) === i
      )
      .sort((a, b) => {
        const ha = parseInt(a.resolution)||0;
        const hb = parseInt(b.resolution)||0;
        return ha - hb;
      });

    // 2) Audio-only formats
    const audioFormats = formats
      .filter(f =>
        (!f.vcodec || f.vcodec === "none") &&
        f.acodec && f.acodec !== "none"
      )
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
          x.extension === fmt.extension &&
          x.protocol  === fmt.protocol
        ) === i
      )
      .sort((a, b) => (b.bitrate||0) - (a.bitrate||0));

    if (!videoFormats.length) {
      return res.status(404).json({ error: "No video formats found" });
    }

    res.json({ videoFormats, audioFormats });
  });
});

app.listen(PORT, () => {
  console.log(`✅ yt-dlp server running on http://localhost:${PORT}`);
});
