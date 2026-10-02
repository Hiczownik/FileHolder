using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Api.ExceptionHandling;

public class GlobalExceptionHandler(
    ILogger<GlobalExceptionHandler> logger,
    IHostEnvironment environment) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(
        HttpContext httpContext,
        Exception exception,
        CancellationToken cancellationToken)
    {
        logger.LogError(
            exception,
            "Unhandled exception occurred. Message: {Message}. InnerException: {InnerMessage}",
            exception.Message,
            exception.InnerException?.Message);

        var problemDetails = new ProblemDetails
        {
            Instance = httpContext.Request.Path,
            Title = "An error occurred while processing your request.",
            Detail = exception.Message
        };

        switch (exception)
        {
            case ArgumentException or InvalidOperationException:
                problemDetails.Status = StatusCodes.Status400BadRequest;
                problemDetails.Title = "Bad Request";
                break;

            case KeyNotFoundException:
                problemDetails.Status = StatusCodes.Status404NotFound;
                problemDetails.Title = "Resource Not Found";
                break;

            case DbUpdateException dbEx:
                problemDetails.Status = StatusCodes.Status500InternalServerError;
                problemDetails.Title = "Database Persistence Error";
                problemDetails.Detail = environment.IsDevelopment()
                    ? (dbEx.InnerException?.Message ?? dbEx.Message)
                    : "An error occurred while saving entity changes to the database.";
                break;

            default:
                problemDetails.Status = StatusCodes.Status500InternalServerError;
                problemDetails.Title = "Internal Server Error";
                break;
        }

        httpContext.Response.StatusCode = problemDetails.Status.Value;
        await httpContext.Response.WriteAsJsonAsync(problemDetails, cancellationToken);
        
        return true; 
    }
}