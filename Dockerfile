# Use a Debian-based image so ffmpeg + yt-dlp work flawlessly
FROM node:20-slim

# Install ffmpeg + python (yt-dlp runs on Python) + curl to fetch yt-dlp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates curl python3 && \
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only prod deps (faster, reproducible)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest
COPY . .

# Helpful envs
ENV NODE_ENV=production
ENV PORT=3000

# Healthcheck (optional but handy in Railway)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

EXPOSE 3000

# Start the server
CMD ["node", "index.js"]
