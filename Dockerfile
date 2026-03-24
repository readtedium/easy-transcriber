FROM node:20-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip build-base \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

RUN mkdir -p uploads public

EXPOSE 3000

CMD ["node", "server.js"]
