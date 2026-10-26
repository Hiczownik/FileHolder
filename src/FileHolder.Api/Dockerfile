# Stage 1: Build & Publish
FROM mcr.microsoft.com/dotnet/sdk:10.0.402@sha256:747cbade5bfd918a175ac32f8f1d931edec2c7d0d5397a3de72eaef1ac1f66d2 AS build
WORKDIR /src

# Copy solution and project files first for optimal Docker layer caching. The package versions live in
# Directory.Packages.props, so restore needs it (and the shared build settings) too.
COPY ["FileHolder.sln", "Directory.Build.props", "Directory.Packages.props", "./"]
COPY ["src/FileHolder.Core/FileHolder.Core.csproj", "src/FileHolder.Core/"]
COPY ["src/FileHolder.Infrastructure/FileHolder.Infrastructure.csproj", "src/FileHolder.Infrastructure/"]
COPY ["src/FileHolder.Api/FileHolder.Api.csproj", "src/FileHolder.Api/"]

RUN dotnet restore "src/FileHolder.Api/FileHolder.Api.csproj"

# Copy full source and publish Release binaries
COPY . .
WORKDIR "/src/src/FileHolder.Api"
# The commit this image is built from: the build context has no .git, so whoever builds passes it (compose reads
# GIT_SHA from the environment). It goes into the assembly's informational version ("0.9.0+abc1234"), which the API
# shows in /healthz, /api/v1/status and fileholder_build_info. Without it, the commit shows as "unknown".
ARG GIT_SHA=""
RUN dotnet publish "FileHolder.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false "/p:SourceRevisionId=${GIT_SHA}"

# Stage 2: Runtime
FROM mcr.microsoft.com/dotnet/aspnet:10.0.13-alpine3.24@sha256:ecf8dcbaab8ebc4bdfb2322d6fe4217bbb118894310ebb6d53c580874ab4b27d AS final
# OCI labels, so `docker inspect` says which build an image is. VERSION is passed by release and deploy builds.
ARG GIT_SHA=""
ARG VERSION="dev"
LABEL org.opencontainers.image.title="fileholder-api" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app
EXPOSE 8080 9464 9465
# 8080 serves the API; 9464 serves only /metrics and is never published outside the compose network; 9465 serves
# the owner's /admin endpoints (with the admin token), published on the host's loopback only.
ENV ASPNETCORE_URLS="http://+:8080;http://+:9464;http://+:9465"

# Hardened security: Run container as non-root user
USER $APP_UID

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "FileHolder.Api.dll"]