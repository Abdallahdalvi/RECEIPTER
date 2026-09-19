FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY . .
RUN mkdir -p /app/data
ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data
EXPOSE 3000
VOLUME ["/app/data"]
CMD ["npm", "start"]
