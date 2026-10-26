using System.Net;
using Amazon.S3;
using FileHolder.Api.Admin;
using FileHolder.Api.Configuration;
using FileHolder.Api.Diagnostics;
using FileHolder.Api.Endpoints;
using FileHolder.Api.ExceptionHandling;
using FileHolder.Api.Health;
using FileHolder.Api.Middleware;
using FileHolder.Api.RateLimiting;
using FileHolder.Api.Telemetry;
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
// Lines written inside a trace end with its ids (TraceContextEnricher).
builder.Host.UseSerilog((ctx, lc) => lc
    .MinimumLevel.Override("Microsoft.AspNetCore", Serilog.Events.LogEventLevel.Warning)
    .Enrich.With<TraceContextEnricher>()
    .WriteTo.Console(
        outputTemplate: "[{Timestamp:HH:mm:ss} {Level:u3}] {Message:lj}{" + TraceContextEnricher.PropertyName + ":l}{NewLine}{Exception}",
        formatProvider: System.Globalization.CultureInfo.InvariantCulture));

builder.Services.AddFileHolderStorageOptions(builder.Configuration);

builder.Services.AddOptions<UploadLimitsOptions>()
    .Bind(builder.Configuration.GetSection(UploadLimitsOptions.SectionName))
    .ValidateDataAnnotations()
    .Validate(o => o.WithoutCodeSettingsAreValid(),
        "UploadLimits:WithoutCodeMaxBundleSizeBytes and WithoutCodeMaxExpiryHours must be set together (access codes, #169), and be no larger than MaxBundleSizeBytes and MaxExpiryHours.")
    .ValidateOnStart();

builder.Services.AddOptions<AdminOptions>()
    .Bind(builder.Configuration.GetSection(AdminOptions.SectionName))
    .ValidateDataAnnotations()
    .ValidateOnStart();

// On a stop (a deploy), how long requests already running may finish: bundle ZIPs stream through the API and are cut
// off after this. Compose's stop_grace_period must be longer, or Docker kills the process first (README, Configuration).
builder.Services.Configure<HostOptions>(options =>
    options.ShutdownTimeout = TimeSpan.FromSeconds(builder.Configuration.GetValue("Hosting:ShutdownTimeoutSeconds", 90)));

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
    options.UseNpgsql(builder.Configuration.GetConnectionString("PostgresConnection")
        ?? throw new InvalidOperationException(
            "ConnectionStrings:PostgresConnection is not set. Compose builds it from POSTGRES_PASSWORD in .env; " +
            "for a local `dotnet run`, set it with dotnet user-secrets (README, Development).")));

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
builder.Services.AddScoped<StorageQuota>();
builder.Services.AddScoped<IMultipartUploadService, MultipartUploadService>();
builder.Services.AddScoped<IBundleStreamService, BundleStreamService>();
builder.Services.AddScoped<IStoragePurgeService, StoragePurgeService>();
// Maintenance modes (README, Maintenance Modes): which requests are let through, switched on the admin port.
builder.Services.AddSingleton<IServiceModeProvider, ServiceModeProvider>();
builder.Services.AddScoped<ITakedownService, TakedownService>();
// Access codes (#169): the full upload limits for those who have one; managed on the admin port.
builder.Services.AddScoped<IAccessCodeService, AccessCodeService>();
builder.Services.AddSingleton<AccessCodeMetrics>();

var metricsPort = builder.Configuration.GetValue("Metrics:Port", 9464);

builder.Services.AddOpenTelemetry()
    .WithMetrics(metrics =>
    {
        metrics
            .AddAspNetCoreInstrumentation()
            .AddRuntimeInstrumentation()
            .AddMeter(StorageLifecycleStatus.MeterName)
            .AddPrometheusExporter();
    });

// Traces, sent only when OTEL_EXPORTER_OTLP_ENDPOINT is set (TracingRegistration).
builder.Services.AddFileHolderTracing(builder.Configuration, builder.Environment, metricsPort);

builder.Services.AddSingleton<IDateTimeProvider, SystemDateTimeProvider>();
builder.Services.AddHostedService<FileCleanupWorker>();
// /healthz/live and /healthz/ready, and their metrics (HealthEndpoints, HealthMetrics).
builder.Services.AddFileHolderHealthChecks();
// The storage-level backstop behind the purge (StorageSafetyNet).
builder.Services.AddSingleton<StorageLifecycleStatus>();
builder.Services.AddHostedService<StorageLifecycleInitializer>();

// WithoutCodeLimitsValidator is built by presign with the limits of an upload without an access code; registered, it
// would be a second validator for presign requests.
builder.Services.AddValidatorsFromAssemblyContaining<Program>(
    filter: scan => scan.ValidatorType != typeof(FileHolder.Api.Validation.WithoutCodeLimitsValidator));

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

builder.Services.AddFileHolderCors(builder.Configuration);

var app = builder.Build();

app.Logger.LogInformation("FileHolder API {Build} starting.", BuildInfo.Current);
BuildInfo.AddMetric(app.Services.GetRequiredService<System.Diagnostics.Metrics.IMeterFactory>(), BuildInfo.Current);

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
    await dbContext.Database.MigrateAsync(CancellationToken.None);
}

// Read once at startup, so a pause left on from before a restart is in the log, and the mode metric has a value.
var startupMode = await app.Services.GetRequiredService<IServiceModeProvider>().GetCurrentAsync(CancellationToken.None);
if (startupMode.Mode != FileHolder.Core.Entities.ServiceMode.Normal)
{
    app.Logger.LogWarning("Starting in service mode {Mode}.", startupMode.Mode);
}

if (string.IsNullOrEmpty(app.Services.GetRequiredService<IOptions<AdminOptions>>().Value.Token))
{
    app.Logger.LogWarning("Admin:Token is not set, so the admin endpoints (maintenance modes) are off.");
}

app.UseExceptionHandler();
app.UseForwardedHeaders();
app.UseSecurityHeaders();
app.UseCors(CorsRegistration.PolicyName);
app.UseRateLimiter();

// Metrics are only served on their own port, which compose never publishes, so only Prometheus on the
// internal network can scrape them. Matched on the port the connection actually arrived on, not the Host
// header, which clients can set to anything.
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
app.MapStatusEndpoints();
app.MapAdminEndpoints();
app.MapHealthEndpoints();

await app.RunAsync(CancellationToken.None);

// Kestrel counts a response as done once its last bytes are in the kernel's send buffer, but Docker removes the
// container's network as soon as this process exits, and what was still buffered (the end of a long bundle ZIP) is
// lost. Staying a moment longer lets it go out. Only on a real stop, after every request has finished.
await Task.Delay(TimeSpan.FromSeconds(builder.Configuration.GetValue("Hosting:LingerSeconds", 5)), CancellationToken.None);

public partial class Program
{
    protected Program() { }
}