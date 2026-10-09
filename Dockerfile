FROM node:22-alpine
WORKDIR /app
COPY server ./server
COPY public ./public
COPY config ./config
RUN mkdir -p data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/server.js"]
