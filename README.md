# 📁 FileHolder — Cloud-Native Self-Destructing File Sharing Platform

> An enterprise-grade, high-performance file-sharing platform engineered with **.NET 10**, **MinIO**, **PostgreSQL 17**, and **React 19**. 
> Utilizes **Direct-to-Storage Presigned Upload URLs** to offload transfer bandwidth, eliminating backend server CPU/memory bottlenecks.

---

## 🚀 Key Architectural Highlights

* **Zero Server Memory Overhead**: Files stream directly from the client browser to MinIO via presigned PUT URLs, bypassing backend memory allocations.
* **.NET 10 Native Standards**: Built with Minimal APIs (`MapGroup`), Native OpenAPI 3.1, `Scalar` UI documentation, `HybridCache` (L1/L2 stampede protection), and RFC 7807 `ProblemDetails` error handling.
* **Security First**: Automatic sanitization against Path Traversal, FluentValidation extension blacklisting (`.exe`, `.sh`, `.dll`), BCrypt password hashing, and Security Headers (`nosniff`, CSP, DENY).
* **Automated Storage Purge Worker**: Custom `.NET BackgroundService` worker periodically purges expired objects from storage and database records in atomic batches.
* **Automated End-to-End Testing**: Fully automated E2E browser testing suite powered by **Microsoft Playwright** and **xUnit Integration Tests**.

---

## 🛠️ Technology Stack Matrix

| Tier | Technology | Justification |
| :--- | :--- | :--- |
| **Backend API** | **.NET 10 (C# 13)** | Native Minimal APIs, high throughput, Native AOT ready |
| **API Docs** | **Scalar UI** | Modern, interactive alternative to Swashbuckle |
| **Database** | **PostgreSQL 17** | Relational metadata storage hostable on free cloud tiers |
| **ORM** | **EF Core 10** | Strong typing, compiled queries, filtered indexes |
| **Object Storage**| **MinIO** | S3-compatible storage run locally in Docker Compose (private bucket, presigned-URL access only) |
| **Caching** | **.NET 10 `HybridCache`** | L1 memory caching with built-in cache stampede locking |
| **Frontend** | **React 19 + Vite 6 + Tailwind v4** | Decoupled SPA communicating via REST and Axios direct S3 PUT |
| **E2E Testing** | **Microsoft Playwright** | Real browser automation (upload -> download -> self-destruct) |
| **Backend Testing**| **xUnit + WebApplicationFactory** | In-memory integration testing pipeline |
| **Containers** | **Docker Compose** | Single-command multi-stage container orchestration |

---

## ⚡ Quick Start (Single-Command Docker Launch)

Ensure [Docker Desktop](https://www.docker.com/products/docker-desktop/) is running, then set a Grafana admin password
(compose refuses to start without one) in a `.env` file next to `docker-compose.yml`, which git ignores:

```bash
echo "GRAFANA_ADMIN_PASSWORD=$(openssl rand -hex 16)" > .env
docker compose up --build
```

### Application Endpoints:
* **React Web App**: [http://localhost:3000](http://localhost:3000)
* **Scalar API Docs**: only when the API runs in Development (e.g. from Rider / `dotnet run`), at [http://localhost:8080/scalar/v1](http://localhost:8080/scalar/v1). The compose stack runs the API in Production.
* **Grafana**: [http://localhost:3001](http://localhost:3001) *(Login: `admin` / your `GRAFANA_ADMIN_PASSWORD`)*
* **MinIO Object Console**: [http://localhost:9001](http://localhost:9001) *(Login: `minioadmin` / `minioadmin`)*
* **API Health Check**: [http://localhost:8080/healthz](http://localhost:8080/healthz)

---

## 🧪 Running the Test Suites

### 1. Execute Backend Integration Tests (.NET xUnit)
```bash
dotnet test tests/FileHolder.Tests.Integration/FileHolder.Tests.Integration.csproj
```

### 2. Execute End-to-End Browser Automation Tests (Playwright)
```bash
cd src/fileholder-ui
npx playwright test
```

*For interactive visual UI testing mode:*
```bash
npx playwright test --ui
```
