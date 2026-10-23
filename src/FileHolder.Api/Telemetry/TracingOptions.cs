using System.ComponentModel.DataAnnotations;

namespace FileHolder.Api.Telemetry;

/// <summary>
/// How much the API traces. Traces are only sent anywhere when OTEL_EXPORTER_OTLP_ENDPOINT is set
/// (see <see cref="TracingRegistration"/>).
/// </summary>
public class TracingOptions
{
    public const string SectionName = "Tracing";

    /// <summary>
    /// The share of requests traced, from 0 to 1. Every request locally and in CI; a deployment that sends traces
    /// somewhere should lower it (0.1 is plenty to see where the time goes).
    /// </summary>
    [Range(0.0, 1.0)]
    public double SampleRatio { get; set; } = 1.0;

    /// <summary>
    /// Whether request spans keep the caller's address. Off by default: with it, a trace says which address
    /// unlocked and downloaded which bundle, and when. Docker Desktop shows every client as one address anyway,
    /// so it only helps on a real host, while debugging rate limits or the password lockout.
    /// </summary>
    public bool RecordClientAddress { get; set; }
}
