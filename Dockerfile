# Build stage
FROM node:18-alpine as builder

WORKDIR /app

# Copy backend
COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Build mini-app
WORKDIR /app/mini-app
COPY mini-app/package*.json ./
RUN npm ci

COPY mini-app/ .
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S cubapoker -u 1001

# Copy backend
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./

# Copy mini-app build
COPY --from=builder /app/mini-app/dist ./mini-app/dist

USER cubapoker

EXPOSE 3000

CMD ["node", "dist/bot.js"]
