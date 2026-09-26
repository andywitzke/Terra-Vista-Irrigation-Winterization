FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
ENV NODE_ENV=production DB_PATH=/data/winterization.db PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
