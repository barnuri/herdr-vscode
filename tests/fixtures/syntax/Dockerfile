# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci && npm run build
ENV PORT=8080 NODE_ENV="production"
EXPOSE 8080
CMD ["node", "dist/index.js"]
