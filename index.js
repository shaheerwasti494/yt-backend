const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get("/stream", (req, res) => {
const id = req.query.id;
if (!id) return res.status(400).json({ error: "Missing video ID" });

const command = `yt-dlp -f "22/18/best[ext=mp4][vcodec*=avc][acodec*=mp4a]" -g "https://www.youtube.com/watch?v=${id}"`;

exec(command, (err, stdout) => {
if (err || !stdout.trim()) {
console.error("yt-dlp error:", err);
return res.status(500).json({ error: "No stream found" });
}
res.json({ streamUrl: stdout.trim() });
});
});

app.listen(PORT, () => {
console.log(`✅ Server running on http://localhost:${PORT}`);
});
