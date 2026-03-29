FROM node:20-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip build-base \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p uploads public/ffmpeg \
  && mkdir /tmp/ff && cd /tmp/ff \
  && npm init -y \
  && npm install @ffmpeg/ffmpeg@0.12.10 @ffmpeg/core@0.12.6 \
  && cp node_modules/@ffmpeg/ffmpeg/dist/esm/*.js /app/public/ffmpeg/ \
  && cp node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js   /app/public/ffmpeg/ \
  && cp node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm /app/public/ffmpeg/ \
  && rm -rf /tmp/ff

EXPOSE 3000

CMD ["node", "server.js"]
