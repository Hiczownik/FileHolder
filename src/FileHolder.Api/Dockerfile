# Stage 1: Build & Publish
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

# Copy solution and project files first for optimal Docker layer caching
COPY ["FileHolder.sln", "./"]
COPY ["src/FileHolder.Core/FileHolder.Core.csproj", "src/FileHolder.Core/"]
COPY ["src/FileHolder.Infrastructure/FileHolder.Infrastructure.csproj", "src/FileHolder.Infrastructure/"]
COPY ["src/FileHolder.Api/FileHolder.Api.csproj", "src/FileHolder.Api/"]

RUN dotnet restore "src/FileHolder.Api/FileHolder.Api.csproj"

# Copy full source and publish Release binaries
COPY . .
WORKDIR "/src/src/FileHolder.Api"
RUN dotnet publish "FileHolder.Api.csproj" -c Release -o /app/publish /p:UseAppHost=false

# Stage 2: Runtime
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS final
WORKDIR /app
EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080

# Hardened security: Run container as non-root user
USER $APP_UID

COPY --from=build /app/publish .
ENTRYPOINT ["dotnet", "FileHolder.Api.dll"]