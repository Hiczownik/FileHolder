using System.Collections.ObjectModel;
using System.Diagnostics;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.TestHost;
using OpenTelemetry.Trace;

namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>The spans an exporter would have sent, safe to read while requests still add to it.</summary>
public sealed class SpanCollection : Collection<Activity>
{
    private readonly Lock _lock = new();

    public Activity[] Snapshot()
    {
        lock (_lock)
        {
            return [.. Items];
        }
    }

    protected override void InsertItem(int index, Activity item)
    {
        lock (_lock)
        {
            base.InsertItem(index, item);
        }
    }
}

/// <summary>
/// The API with an in-memory exporter after its own processors, so tests see exactly what would leave the API.
/// </summary>
public class TracingFactory : CustomWebApplicationFactory
{
    public SpanCollection Spans { get; } = [];

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        base.ConfigureWebHost(builder);
        builder.ConfigureTestServices(services =>
            services.ConfigureOpenTelemetryTracerProvider(tracing => tracing.AddInMemoryExporter(Spans)));
    }

    /// <summary>
    /// The spans of one trace, once it has the given number of request spans: a request's span ends just after
    /// its response is sent, so the last one can still be open when the client has the response.
    /// </summary>
    public async Task<Activity[]> WaitForRequestSpansAsync(ActivityTraceId traceId, int count)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            var spans = Spans.Snapshot().Where(s => s.TraceId == traceId).ToArray();
            if (spans.Count(s => s.Kind == ActivityKind.Server) >= count || DateTime.UtcNow > deadline)
            {
                return spans;
            }

            await Task.Delay(20);
        }
    }
}

/// <summary>
/// Tracing tests count the spans of whole requests. The ASP.NET Core instrumentation behind them is shared by every
/// test host in the process, and other test classes start and stop hosts all the time (startup checks especially),
/// which made request spans go missing now and then. Classes in this collection run on their own, after the rest.
/// </summary>
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class TracingCollectionDefinition
{
    public const string Name = "Tracing";

    private TracingCollectionDefinition()
    {
    }
}
