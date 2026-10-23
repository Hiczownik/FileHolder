using System.Reflection;
using Microsoft.Extensions.Options;
using Npgsql;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace FileHolder.Api.Telemetry;

public static class TracingRegistration
{
    public const string ServiceName = "fileholder-api";

    /// <summary>The API's own spans (confirm, presign, purge batches…) come from an ActivitySource of this name.</summary>
    public const string SourceName = "FileHolder";

    public const string OtlpEndpointSetting = "OTEL_EXPORTER_OTLP_ENDPOINT";

    /// <summary>
    /// Traces requests, database queries and storage calls (see <see cref="TraceRedactionProcessor"/> for what
    /// they leave out), and sends them over OTLP only when OTEL_EXPORTER_OTLP_ENDPOINT is set, so the API runs the
    /// same without a trace store. The health endpoints and metrics aren't traced.
    /// </summary>
    public static IServiceCollection AddFileHolderTracing(
        this IServiceCollection services, IConfiguration configuration, IHostEnvironment environment, int metricsPort)
    {
        services.AddOptions<TracingOptions>()
            .Bind(configuration.GetSection(TracingOptions.SectionName))
            .ValidateDataAnnotations()
            .ValidateOnStart();

        var serviceVersion = typeof(TracingRegistration).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;

        services.AddOpenTelemetry().WithTracing(tracing =>
        {
            tracing
                .ConfigureResource(resource => resource
                    .AddService(ServiceName, serviceVersion: serviceVersion)
                    .AddAttributes([new("deployment.environment.name", environment.EnvironmentName)]))
                .SetSampler(sp => new ParentBasedSampler(
                    new RequestRootSampler(sp.GetRequiredService<IOptions<TracingOptions>>().Value.SampleRatio)))
                .AddSource(SourceName)
                .AddAspNetCoreInstrumentation(options => options.Filter = context =>
                    context.Connection.LocalPort != metricsPort && !context.Request.Path.StartsWithSegments("/healthz"))
                // The AWS SDK sends its storage requests through HttpClient, so these are the storage calls.
                .AddHttpClientInstrumentation()
                // Query text only: Npgsql never records parameter values unless asked to.
                .AddNpgsql()
                // Before any exporter, so nothing is exported unredacted.
                .AddProcessor(sp => new TraceRedactionProcessor(sp.GetRequiredService<IOptions<TracingOptions>>()));

            if (ShouldExport(configuration))
            {
                // Reads the endpoint (and the other OTEL_EXPORTER_OTLP_* settings) itself.
                tracing.AddOtlpExporter();
            }
        });

        return services;
    }

    public static bool ShouldExport(IConfiguration configuration) =>
        !string.IsNullOrWhiteSpace(configuration[OtlpEndpointSetting]);
}
