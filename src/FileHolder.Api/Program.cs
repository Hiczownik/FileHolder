using System.Threading.RateLimiting;
using Amazon.S3;
using FileHolder.Api.Endpoints;
using FileHolder.Api.ExceptionHandling;
using FileHolder.Api.Middleware;
using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using FileHolder.Infrastructure.Workers;
using FluentValidation;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Options;
using OpenTelemetry.Metrics;
using Scalar.AspNetCore;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((ctx, lc) => lc.WriteTo.Console(formatProvider: System.Globalization.CultureInfo.InvariantCulture));

builder.Services.AddOptions<StorageOptions>()
    .Bind(builder.Configuration.GetSection(StorageOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddOpenApi();

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

builder.Services.AddExceptionHandler<GlobalExceptionHandler>();
builder.Services.AddProblemDetails();

builder.Services.AddDbContext<AppDbContext>(options =>
    options.UseNpgsql(builder.Configuration.GetConnectionString("PostgresConnection")));

builder.Services.AddKeyedSingleton<IAmazonS3>("InternalS3", (sp, _) =>
{
    var storageOptions = sp.GetRequiredService<IOptions<StorageOptions>>().Value;
    var config = new AmazonS3Config
    {
        ServiceURL = storageOptions.ServiceUrl,
        ForcePathStyle = true,
        UseHttp = true,
        AuthenticationRegion = "us-east-1"
    };
    return new AmazonS3Client(storageOptions.AccessKey, storageOptions.SecretKey, config);
});

builder.Services.AddKeyedSingleton<IAmazonS3>("PresignS3", (sp, _) =>
{
    var storageOptions = sp.GetRequiredService<IOptions<StorageOptions>>().Value;
    var config = new AmazonS3Config
    {
        ServiceURL = storageOptions.PublicBaseUrl,
        ForcePathStyle = true,
        UseHttp = true,
        AuthenticationRegion = "us-east-1"
    };
    return new AmazonS3Client(storageOptions.AccessKey, storageOptions.SecretKey, config);
});

builder.Services.AddSingleton<IS3StorageProvider, S3StorageProvider>();
builder.Services.AddScoped<IFileGroupService, FileGroupService>();
builder.Services.AddScoped<IMultipartUploadService, MultipartUploadService>();
builder.Services.AddScoped<IBundleStreamService, BundleStreamService>();
builder.Services.AddScoped<IStoragePurgeService, StoragePurgeService>();

builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics
            .AddAspNetCoreInstrumentation()
            .AddRuntimeInstrumentation()
            .AddPrometheusExporter();
    });

builder.Services.AddSingleton<IDateTimeProvider, SystemDateTimeProvider>();
builder.Services.AddHostedService<FileCleanupWorker>();

builder.Services.AddValidatorsFromAssemblyContaining<Program>();

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
});

static string ResolveClientIp(HttpContext context)
{
    if (context.Request.Headers.TryGetValue("X-Forwarded-For", out var forwarded) &&
        !string.IsNullOrWhiteSpace(forwarded))
    {
        return forwarded.ToString().Split(',')[0].Trim();
    }
    return context.Connection.RemoteIpAddress?.ToString() ?? "anonymous";
}

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // 1. Front Door: Strict 10 / min per IP
    options.AddPolicy("UploadInitiatePolicy", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ResolveClientIp(context),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1)
            }));

    // 2. In-Flight Pipeline: High throughput 100 / min per IP
    options.AddPolicy("MultipartPipelinePolicy", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ResolveClientIp(context),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 100,
                Window = TimeSpan.FromMinutes(1)
            }));

    // 3. Downloader & Vault: 30 / min per IP
    options.AddPolicy("DownloadPolicy", context =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: ResolveClientIp(context),
            factory: _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1)
            }));
});

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

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await dbContext.Database.EnsureCreatedAsync(CancellationToken.None);
    await dbContext.Database.ExecuteSqlRawAsync(@"
        ALTER TABLE ""FileGroups"" ADD COLUMN IF NOT EXISTS ""KeyEnvelope"" text;
        ALTER TABLE ""FileGroups"" ADD COLUMN IF NOT EXISTS ""KeySalt"" character varying(64);
    ", CancellationToken.None);
}

app.UseExceptionHandler();
app.UseForwardedHeaders();
app.UseSecurityHeaders();
app.UseCors("AllowReactApp");
app.UseRateLimiter();

app.MapPrometheusScrapingEndpoint();

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
    app.MapScalarApiReference(options =>
    {
        options.Title = "FileHolder Engine .NET 10 API Reference";
        options.Theme = ScalarTheme.Purple;
    });
}

app.MapFileEndpoints();
app.MapHealthEndpoints();

await app.RunAsync(CancellationToken.None);

public partial class Program
{
    protected Program() { }
}