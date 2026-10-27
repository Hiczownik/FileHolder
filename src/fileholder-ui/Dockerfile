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
# Who runs the deployment and where to write about it, on the terms and privacy pages; .env.production has FileHolder's.
ARG VITE_OPERATOR_NAME="Henryk I"
ENV VITE_OPERATOR_NAME=$VITE_OPERATOR_NAME
ARG VITE_CONTACT_EMAIL=security@fileholder.app
ENV VITE_CONTACT_EMAIL=$VITE_CONTACT_EMAIL
# The commit the UI is built from, shown in the footer and the diagnostics report (vite.config.ts). The build context
# has no .git, so whoever builds passes it; compose reads GIT_SHA from the environment.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA

RUN npm run build
# The sample keeper (stage "sample" below) talks to the API container directly, not through nginx.
ARG SAMPLE_API_BASE_URL=http://api:8080/api/v1/files
RUN VITE_API_BASE_URL=$SAMPLE_API_BASE_URL npm run build:sample

# The sample keeper (README, Sample Bundle): keeps a public sample bundle alive for /sample. Built with
# `--target sample`; without a target, the build ends at the nginx stage below as before.
FROM node:26.12.1-alpine3.24@sha256:40cd011b55415bc894e45b02fdd5a5dfde056921b7d23a64c74f80497af48797 AS sample
ARG GIT_SHA=""
ARG VERSION="dev"
LABEL org.opencontainers.image.title="fileholder-sample"       org.opencontainers.image.version="${VERSION}"       org.opencontainers.image.revision="${GIT_SHA}"       org.opencontainers.image.licenses="MIT"
# The keeper is one bundled file; npm and corepack are never used, so they (and their vulnerabilities) go.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack     && mkdir /data && chown node:node /data
WORKDIR /app
COPY --from=build /app/dist-sample ./
COPY sample-content/ ./content/
# The pointer to the current sample goes in /data, a volume nginx serves at /sample-bundle/ (docker-compose.prod.yml). A
# new volume takes the owner of the directory it's mounted over, so the keeper writes to it without running as root.
USER node
CMD ["node", "main.js"]

# Stage 2: Serve static files with Nginx
FROM nginx:1.31.8-alpine3.24@sha256:e2d97c2b8c016f12c2f1a27d095685063b2f281c4edf2babfde6001cf4fb77a8 AS final
# OCI labels, so `docker inspect` says which build an image is. VERSION is passed by release and deploy builds.
ARG GIT_SHA=""
ARG VERSION="dev"
LABEL org.opencontainers.image.title="fileholder-ui" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="MIT"
# The base image carries curl, which nothing here uses (the healthcheck uses BusyBox wget), and older brotli-libs
# (freetype needs it). Removing curl drops libcurl with it; brotli-libs is upgraded to Alpine's fixed release. Both
# had HIGH vulnerabilities the base image hasn't picked up yet (Trivy, 2026-10-26). Remove once the base image has them.
RUN apk del --no-cache curl \
    && apk add --no-cache --upgrade brotli-libs
COPY --from=build /app/dist /usr/share/nginx/html
# The image fills in templates when the container starts, writing /etc/nginx/conf.d/default.conf. Only
# STORAGE_PUBLIC_URL is replaced: the config's own $variables must stay as they are.
ENV NGINX_ENVSUBST_FILTER=^STORAGE_PUBLIC_URL$
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
# Checks STORAGE_PUBLIC_URL first; the container won't start without a valid one (set in docker-compose.yml).
COPY --chmod=755 docker-entrypoint.d/19-storage-public-url.envsh /docker-entrypoint.d/
# Writes the access log's client-address setting (NGINX_LOG_CLIENT_ADDRESS, off by default); refuses an unknown value.
COPY --chmod=755 docker-entrypoint.d/17-client-address-log.envsh /docker-entrypoint.d/
# Writes the trusted-proxy settings (TRUSTED_PROXIES) the config relies on; refuses a malformed value.
COPY --chmod=755 docker-entrypoint.d/18-trusted-proxies.envsh /docker-entrypoint.d/

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]