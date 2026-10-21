using FileHolder.Core.Exceptions;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Api.ExceptionHandling;

public class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IHostEnvironment environment) : IExceptionHandler
{
    private const string InvalidBodyDetail = "The request body could not be read. Check that it is valid JSON of the expected shape.";

    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        // Logged by route, not path: a path holds the share token, which opens a bundle without a password.
        var route = RouteOf(httpContext);

        // The client disconnected: nobody is left to answer, and it is not a server fault.
        if (exception is OperationCanceledException && httpContext.RequestAborted.IsCancellationRequested)
        {
            logger.LogInformation("Request {Route} was cancelled by the client.", route);
            return true;
        }

        // Only exceptions thrown on purpose for the caller carry a message meant for the client. Anything else
        // (framework, EF, S3, bugs) is a 500 with a generic detail, whatever its type, so internal messages
        // never leak and an internal InvalidOperationException is never misreported as the client's fault.
        var (status, title, detail) = exception switch
        {
            InvalidRequestException => (StatusCodes.Status400BadRequest, "Bad Request", exception.Message),
            ResourceNotFoundException => (StatusCodes.Status404NotFound, "Resource Not Found", exception.Message),
            ConflictException => (StatusCodes.Status409Conflict, "Conflict", exception.Message),
            BadHttpRequestException badRequest => (badRequest.StatusCode, "Bad Request", InvalidBodyDetail),
            DbUpdateException => (StatusCodes.Status500InternalServerError, "Database Persistence Error",
                "An error occurred while saving entity changes to the database."),
            _ => (StatusCodes.Status500InternalServerError, "Internal Server Error", "An unexpected error occurred.")
        };

        if (status >= StatusCodes.Status500InternalServerError)
        {
            logger.LogError(exception, "Unhandled exception while processing {Route}.", route);
        }
        else
        {
            // A client error's message can name the user's files, so it is only logged at Debug.
            logger.LogWarning("Request {Route} rejected with {StatusCode} ({ExceptionType}).",
                route, status, exception.GetType().Name);
            logger.LogDebug("Request {Route} rejection detail: {Message}",
                route, exception.InnerException?.Message ?? exception.Message);
        }

        if (environment.IsDevelopment() && (status >= StatusCodes.Status500InternalServerError || exception is BadHttpRequestException))
        {
            detail = exception.InnerException?.Message ?? exception.Message;
        }

        // Once the body has started (e.g. a ZIP stream failing midway) a problem response can't be written.
        // Abort, so the client sees a failed download instead of a truncated file that looks complete.
        if (httpContext.Response.HasStarted)
        {
            httpContext.Abort();
            return true;
        }

        var problemDetails = new ProblemDetails
        {
            Instance = httpContext.Request.Path,
            Status = status,
            Title = title,
            Detail = detail
        };

        httpContext.Response.StatusCode = status;
        await httpContext.Response.WriteAsJsonAsync(problemDetails, cancellationToken);

        return true;
    }

    private static string RouteOf(HttpContext httpContext) =>
        (httpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "(no route)";
}
