using System.Text.Json;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace FileHolder.Api.Health;

/// <summary>
/// Writes a health report as JSON: the overall status, then each check's status, duration, description and
/// numbers. Only the checks' own descriptions and counts are written, never an exception message, which could
/// carry a connection string, a host or a storage key.
/// </summary>
public static class HealthResponseWriter
{
    private static readonly JsonSerializerOptions Options = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static Task WriteAsync(HttpContext context, HealthReport report)
    {
        context.Response.ContentType = "application/json; charset=utf-8";
        var body = new
        {
            Status = report.Status.ToString(),
            TotalDurationMs = (long)report.TotalDuration.TotalMilliseconds,
            Checks = report.Entries.ToDictionary(
                entry => entry.Key,
                entry => new
                {
                    Status = entry.Value.Status.ToString(),
                    DurationMs = (long)entry.Value.Duration.TotalMilliseconds,
                    entry.Value.Description,
                    Data = entry.Value.Data.Count == 0 ? null : entry.Value.Data,
                }),
        };
        return context.Response.WriteAsync(JsonSerializer.Serialize(body, Options), context.RequestAborted);
    }
}
