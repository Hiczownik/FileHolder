# Stage 1: Build React static assets
FROM node:26.12.0-alpine3.24@sha256:6f08a523443ddedf52941874c203475b0ad503e859ad70cb26ab8be9a517dbd5 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Same-origin by default: nginx forwards /api/ to the API container (see nginx.conf.template).
ARG VITE_API_BASE_URL=/api/v1/files
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# Stage 2: Serve static files with Nginx
FROM nginx:1.31.8-alpine3.24@sha256:e2d97c2b8c016f12c2f1a27d095685063b2f281c4edf2babfde6001cf4fb77a8 AS final
COPY --from=build /app/dist /usr/share/nginx/html
# The image fills in templates when the container starts, writing /etc/nginx/conf.d/default.conf. Only
# STORAGE_PUBLIC_URL is replaced: the config's own $variables must stay as they are.
ENV NGINX_ENVSUBST_FILTER=^STORAGE_PUBLIC_URL$
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Checks STORAGE_PUBLIC_URL first; the container won't start without a valid one (set in docker-compose.yml).
COPY --chmod=755 docker-entrypoint.d/19-storage-public-url.envsh /docker-entrypoint.d/

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]