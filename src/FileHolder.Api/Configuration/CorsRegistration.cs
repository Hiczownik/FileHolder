using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Configuration;

/// <summary>The "Cors" section: the origins whose pages may call the API cross-origin.</summary>
public sealed class CorsSettings
{
    public const string SectionName = "Cors";

    public string[] AllowedOrigins { get; set; } = [];
}

public static class CorsRegistration
{
    public const string PolicyName = "ConfiguredOrigins";
    public const string AllowedOriginsSection = $"{CorsSettings.SectionName}:{nameof(CorsSettings.AllowedOrigins)}";

    /// <summary>
    /// Browsers normally reach the API same-origin, through the UI's proxy, which needs no CORS at all. Pages served
    /// from another origin (the Vite dev server, say) must be listed under Cors:AllowedOrigins; none are by default.
    /// The API refuses to start with an entry that isn't a bare origin, since one with a path or a trailing slash
    /// never matches what browsers send and would fail silently.
    /// </summary>
    public static IServiceCollection AddFileHolderCors(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<CorsSettings>()
            .Bind(configuration.GetSection(CorsSettings.SectionName))
            .Validate(settings => settings.AllowedOrigins.All(IsBareOrigin),
                $"{AllowedOriginsSection} has an entry that isn't an origin. Use the scheme, host and port only, " +
                "with no path or trailing slash, like \"https://fileholder.app\".")
            .ValidateOnStart();

        services.AddCors();
        services.AddOptions<CorsOptions>().Configure<IOptions<CorsSettings>>((options, settings) =>
            options.AddPolicy(PolicyName, policy => policy
                .WithOrigins(settings.Value.AllowedOrigins)
                .AllowAnyHeader()
                .AllowAnyMethod()
                // So the browser can read how long to wait after a 429 (see RateLimitPolicies.WriteRetryAfterAsync).
                .WithExposedHeaders("Retry-After")));
        return services;
    }

    private static bool IsBareOrigin(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri)
        && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
        && string.Equals(value, uri.GetLeftPart(UriPartial.Authority), StringComparison.OrdinalIgnoreCase);
}
