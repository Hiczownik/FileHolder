using System.Globalization;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileHolder.Api.ServiceModes;

/// <summary>
/// Refuses a request the current <see cref="ServiceMode"/> doesn't allow (<see cref="ServiceModeRules"/>) with a
/// 503, a Retry-After, and the mode in the problem's <c>mode</c> field, so the UI can tell it from other 503s
/// (a full storage quota) and show the owner's message.
/// </summary>
public static class ServiceModeFilter
{
    public const string ModeExtension = "mode";

    /// <summary>Lets the request through only in modes that allow <paramref name="capability"/>.</summary>
    public static RouteHandlerBuilder RequireServiceMode(this RouteHandlerBuilder builder, ServiceCapability capability) =>
        builder.RequireServiceMode(_ => capability);

    /// <summary>For an endpoint whose capability depends on the request, e.g. with or without a download session.</summary>
    public static RouteHandlerBuilder RequireServiceMode(
        this RouteHandlerBuilder builder, Func<EndpointFilterInvocationContext, ServiceCapability> capabilityOf) =>
        builder.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var status = await http.RequestServices.GetRequiredService<IServiceModeProvider>()
                .GetCurrentAsync(http.RequestAborted);

            if (ServiceModeRules.Allows(status.Mode, capabilityOf(context)))
            {
                return await next(context);
            }

            var now = http.RequestServices.GetRequiredService<IDateTimeProvider>().UtcNow;
            http.Response.Headers.RetryAfter = RetryAfterSeconds(status, now).ToString(CultureInfo.InvariantCulture);
            return Refusal(status);
        });

    /// <summary>Until the owner's <c>until</c> when it's ahead, otherwise <see cref="ServiceModeRules.DefaultRetryAfter"/>.</summary>
    public static int RetryAfterSeconds(ServiceStatusDto status, DateTime utcNow)
    {
        var wait = status.Until is { } until && until > utcNow ? until - utcNow : ServiceModeRules.DefaultRetryAfter;
        return Math.Max(1, (int)Math.Ceiling(wait.TotalSeconds));
    }

    private static ProblemHttpResult Refusal(ServiceStatusDto status)
    {
        var (title, detail) = status.Mode switch
        {
            ServiceMode.UploadsPaused => ("Uploads Paused", "New uploads are paused for now. Shared links still work."),
            ServiceMode.ReadOnly => ("Read-Only Mode", "FileHolder is read-only for now: nothing new can be uploaded or downloaded."),
            _ => ("Temporarily Closed", "FileHolder is closed for now. Please try again later."),
        };

        return TypedResults.Problem(
            detail: status.Message ?? detail,
            statusCode: StatusCodes.Status503ServiceUnavailable,
            title: title,
            extensions: new Dictionary<string, object?> { [ModeExtension] = status.Mode.ToString() });
    }
}
