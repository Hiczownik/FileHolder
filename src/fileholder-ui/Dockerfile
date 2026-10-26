# Stage 1: Build React static assets
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Same-origin by default: nginx forwards /api/ to the API container (see nginx.conf.template).
ARG VITE_API_BASE_URL=/api/v1/files
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
# Where the "Report abuse" links send email; .env.production has FileHolder's. An empty value hides the links.
ARG VITE_ABUSE_EMAIL=abuse@fileholder.app
ENV VITE_ABUSE_EMAIL=$VITE_ABUSE_EMAIL
# The commit the UI is built from, shown in the footer and the diagnostics report (vite.config.ts). The build context
# has no .git, so whoever builds passes it; compose reads GIT_SHA from the environment.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

RUN npm run build

# Stage 2: Serve static files with Nginx
FROM nginx:1.31.8-alpine3.24@sha256:e2d97c2b8c016f12c2f1a27d095685063b2f281c4edf2babfde6001cf4fb77a8 AS final
# OCI labels, so `docker inspect` says which build an image is. VERSION is passed by release and deploy builds.
ARG GIT_SHA=""
ARG VERSION="dev"
LABEL org.opencontainers.image.title="fileholder-ui" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /app/dist /usr/share/nginx/html
# The image fills in templates when the container starts, writing /etc/nginx/conf.d/default.conf. Only
# STORAGE_PUBLIC_URL is replaced: the config's own $variables must stay as they are.
ENV NGINX_ENVSUBST_FILTER=^STORAGE_PUBLIC_URL$
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Checks STORAGE_PUBLIC_URL first; the container won't start without a valid one (set in docker-compose.yml).
COPY --chmod=755 docker-entrypoint.d/19-storage-public-url.envsh /docker-entrypoint.d/
# Writes the trusted-proxy settings (TRUSTED_PROXIES) the config relies on; refuses a malformed value.
COPY --chmod=755 docker-entrypoint.d/18-trusted-proxies.envsh /docker-entrypoint.d/

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]