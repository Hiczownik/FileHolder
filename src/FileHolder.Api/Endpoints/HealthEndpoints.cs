using FileHolder.Api.Health;
using Microsoft.AspNetCore.Diagnostics.HealthChecks;

namespace FileHolder.Api.Endpoints;

/// <summary>
/// /healthz/live: the process is up and answering; checks nothing else.
/// /healthz/ready: every check (database, storage, the lifecycle safety net, the purge worker and its backlog):
/// 200 when Healthy or Degraded, 503 when Unhealthy. What compose and CI wait for.
/// /healthz: the same as /healthz/ready, for existing links and habits.
///
/// Served by the API itself (port 8080, loopback-only in compose); nginx only forwards /api/, so the details stay
/// local. If these are ever reachable from outside, return only the overall status there (#82).
/// </summary>
public static class HealthEndpoints
{
    public static void MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        var ready = new HealthCheckOptions { ResponseWriter = HealthResponseWriter.WriteAsync };

        app.MapHealthChecks("/healthz/live", new HealthCheckOptions
        {
            Predicate = _ => false,
            ResponseWriter = HealthResponseWriter.WriteAsync,
        });
        app.MapHealthChecks("/healthz/ready", ready);
        app.MapHealthChecks("/healthz", ready);
    }
}
