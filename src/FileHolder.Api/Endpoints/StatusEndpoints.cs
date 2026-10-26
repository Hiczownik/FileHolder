using FileHolder.Api.RateLimiting;
using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileHolder.Api.Endpoints;

public static class StatusEndpoints
{
    /// <summary>
    /// GET /api/v1/status: the service mode, the owner's message and when they expect it to end. The UI checks it on
    /// load to show a banner, disable the upload form, or show the closed page. Answers in every mode.
    /// </summary>
    public static void MapStatusEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/v1/status", GetStatus)
            .RequireRateLimiting(RateLimitPolicies.Metadata)
            .WithTags("Status")
            .WithName("GetServiceStatus");
    }

    public static async Task<Ok<ServiceStatusDto>> GetStatus(IServiceModeProvider serviceMode, HttpContext context)
    {
        // A cached copy would hide a pause, or keep showing one that's over.
        context.Response.Headers.CacheControl = "no-store";
        return TypedResults.Ok(await serviceMode.GetCurrentAsync(context.RequestAborted));
    }
}
