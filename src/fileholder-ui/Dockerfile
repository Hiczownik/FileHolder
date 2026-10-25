# Stage 1: Build React static assets
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Same-origin by default: nginx forwards /api/ to the API container (see nginx.conf).
ARG VITE_API_BASE_URL=/api/v1/files
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# Stage 2: Serve static files with Nginx
FROM nginx:1.31.8-alpine3.24@sha256:e2d97c2b8c016f12c2f1a27d095685063b2f281c4edf2babfde6001cf4fb77a8 AS final
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]