using System.Diagnostics;
using Serilog.Core;
using Serilog.Events;

namespace FileHolder.Api.Telemetry;

/// <summary>
/// Adds " trace=… span=…" to log lines written inside a recorded trace, so a line leads to its trace in Grafana.
/// Lines outside one, or in a request the sampler left out, get nothing: there is no trace to find.
/// </summary>
public sealed class TraceContextEnricher : ILogEventEnricher
{
    public const string PropertyName = "TraceContext";

    public void Enrich(LogEvent logEvent, ILogEventPropertyFactory propertyFactory)
    {
        if (Activity.Current is { Recorded: true } activity)
        {
            logEvent.AddPropertyIfAbsent(propertyFactory.CreateProperty(
                PropertyName, $" trace={activity.TraceId} span={activity.SpanId}"));
        }
    }
}
