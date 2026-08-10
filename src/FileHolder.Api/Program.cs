using Amazon.S3;
using FileHolder.Api.Endpoints;
using FileHolder.Api.ExceptionHandling;
using FileHolder.Api.Middleware;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using FluentValidation;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;
using Scalar.AspNetCore;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// 1. Serilog Logging
builder.Host.UseSerilog((ctx, lc) => lc.WriteTo.Console());

// 2. OpenAPI 3.1 & Scalar Documentation
builder.Services.AddOpenApi();

// 3. Native .NET 10 HybridCache
#pragma warning disable EXTEXP0018
builder.Services.AddHybridCache(options =>
{
    options.MaximumPayloadBytes = 1024 * 1024;
    options.DefaultEntryOptions = new HybridCacheEntryOptions
    {
        Expiration = TimeSpan.FromMinutes(30),
        LocalCacheExpiration = TimeSpan.FromMinutes(5)
    };
});
#pragma warning restore EXTEXP0018

// 4. Centralized RFC 7807 ProblemDetails Exception Handling
builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
builder.Services.AddProblemDetails();

// 5. Database Context (PostgreSQL)
builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("PostgresConnection")));

// 6. Register Amazon S3 Client for MinIO / Cloudflare R2 Compatibility
builder.Services.AddSingleton<IAmazonS3>(sp =>
{
    var config = new AmazonS3Config
    {
        ServiceURL = builder.Configuration["Storage:ServiceUrl"],
        ForcePathStyle = true,
        UseHttp = true // Force HTTP mode for local MinIO
    };
    return new AmazonS3Client(
        builder.Configuration["Storage:AccessKey"],
        builder.Configuration["Storage:SecretKey"],
        config);
});

// 7. Domain Services & Utilities
builder.Services.AddSingleton<IDateTimeProvider, SystemDateTimeProvider>();
builder.Services.AddScoped<IStorageService, StorageService>();
builder.Services.AddHostedService<FileCleanupWorker>();

// 8. FluentValidation Registration
builder.Services.AddValidatorsFromAssemblyContaining<Program>();

// 9. Rate Limiting Middleware
builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    
    options.AddFixedWindowLimiter("UploadPolicy", policy =>
    {
        policy.PermitLimit = 10;
        policy.Window = TimeSpan.FromMinutes(1);
    });

    options.AddFixedWindowLimiter("DownloadPolicy", policy =>
    {
        policy.PermitLimit = 30;
        policy.Window = TimeSpan.FromMinutes(1);
    });
});

// 10. CORS Policy for React Frontend
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowReactApp", policy =>
    {
        policy.WithOrigins("http://localhost:3000", "http://localhost:5173")
              .AllowAnyHeader()
              .AllowAnyMethod();
    });
});

var app = builder.Build();

// Automatically ensure PostgreSQL database tables are created on startup
using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    dbContext.Database.EnsureCreated();
}

// Pipeline Middleware Configuration
app.UseExceptionHandler();
app.UseSecurityHeaders();
app.UseCors("AllowReactApp");
app.UseRateLimiter();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference(options =>
    {
        options.Title = "FileHolder Engine .NET 10 API Reference";
        options.Theme = ScalarTheme.Purple;
    });
}

// Map Modular Route Groups
app.MapFileEndpoints();
app.MapHealthEndpoints();

app.Run();

public partial class Program { }