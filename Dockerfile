FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production PORT=3000
# The database lives in /app/data by default; mount a volume there
# (Railway: attach a volume and the app finds it via RAILWAY_VOLUME_MOUNT_PATH).
EXPOSE 3000
CMD ["npm", "start"]
