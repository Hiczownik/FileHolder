namespace FileHolder.Api.Endpoints;

public static class HealthEndpoints
{
    public static void MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/healthz", () => TypedResults.Ok(new { Status = "Healthy", Timestamp = DateTime.UtcNow}))
            .WithTags("Health");
    } 
}