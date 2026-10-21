using System.Net;
using Amazon.S3;
using FileHolder.Api.Configuration;
using FileHolder.Api.Endpoints;
using FileHolder.Api.ExceptionHandling;
using FileHolder.Api.Middleware;
using FileHolder.Api.RateLimiting;
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

// Serilog ignores the Logging:LogLevel settings. Without this, ASP.NET Core logs every request's path at
// Information, and a path holds the share token, which opens a bundle without a password.
builder.Host.UseSerilog((ctx, lc) => lc
    .MinimumLevel.Override("Microsoft.AspNetCore", Serilog.Events.LogEventLevel.Warning)
    .WriteTo.Console(formatProvider: System.Globalization.CultureInfo.InvariantCulture));

builder.Services.AddFileHolderStorageOptions(builder.Configuration);

builder.Services.AddOptions<UploadLimitsOptions>()
    .Bind(builder.Configuration.GetSection(UploadLimitsOptions.SectionName))
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

// The API's own connection to storage.
builder.Services.AddKeyedSingleton<IAmazonS3>("InternalS3", (sp, _) =>
{
    var storageOptions = sp.GetRequiredService<IOptions<StorageOptions>>().Value;
    return S3ClientFactory.Create(storageOptions.ServiceUrl, storageOptions.AccessKey, storageOptions.SecretKey);
});

// Only signs URLs for browsers, against the address they can reach; it never sends a request itself.
builder.Services.AddKeyedSingleton<IAmazonS3>("PresignS3", (sp, _) =>
{
    var storageOptions = sp.GetRequiredService<IOptions<StorageOptions>>().Value;
    return S3ClientFactory.Create(storageOptions.PublicBaseUrl, storageOptions.AccessKey, storageOptions.SecretKey);
});

builder.Services.AddSingleton<IS3StorageProvider, S3StorageProvider>();
builder.Services.AddScoped<IPasswordAttemptGuard, PasswordAttemptGuard>();
builder.Services.AddScoped<IDownloadSessionService, DownloadSessionService>();
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
            .AddMeter(StorageLifecycleStatus.MeterName)
            .AddPrometheusExporter();
    });

builder.Services.AddSingleton<IDateTimeProvider, SystemDateTimeProvider>();
builder.Services.AddHostedService<FileCleanupWorker>();
// The storage-level backstop behind the purge (StorageSafetyNet).
builder.Services.AddSingleton<StorageLifecycleStatus>();
builder.Services.AddHostedService<StorageLifecycleInitializer>();

builder.Services.AddValidatorsFromAssemblyContaining<Program>();

builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;

    // X-Forwarded-For is only honoured from these proxies (loopback by default). Behind a reverse proxy,
    // list its address under ForwardedHeaders:KnownProxies, or every client shares the proxy's rate limit.
    foreach (var proxy in builder.Configuration.GetSection("ForwardedHeaders:KnownProxies").Get<string[]>() ?? [])
    {
        options.KnownProxies.Add(IPAddress.Parse(proxy));
    }

    // For proxies without a fixed address (e.g. a load balancer pool), trust a CIDR range instead, like "10.0.1.0/24".
    // Only list ranges nothing but your proxies can send from: anyone inside one can claim any client address.
    foreach (var network in builder.Configuration.GetSection("ForwardedHeaders:KnownNetworks").Get<string[]>() ?? [])
    {
        options.KnownIPNetworks.Add(System.Net.IPNetwork.Parse(network));
    }
});

builder.Services.AddFileHolderRateLimits(builder.Configuration);

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowReactApp", policy =>
    {
        policy.WithOrigins("http://localhost:3000", "http://localhost:5173")
              .AllowAnyHeader()
              .AllowAnyMethod()
              // So the browser can read how long to wait after a 429 (see RateLimitPolicies.WriteRetryAfterAsync).
              .WithExposedHeaders("Retry-After");
    });
});

var app = builder.Build();

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await dbContext.Database.MigrateAsync(CancellationToken.None);
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

// Metrics are only served on their own port, which compose never publishes, so only Prometheus on the
// internal network can scrape them. Matched on the port the connection actually arrived on, not the Host
// header, which clients can set to anything.
var metricsPort = app.Configuration.GetValue("Metrics:Port", 9464);
app.UseOpenTelemetryPrometheusScrapingEndpoint(context =>
    context.Connection.LocalPort == metricsPort && context.Request.Path == "/metrics");

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