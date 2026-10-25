using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Configuration;

public static class StorageRegistration
{
    /// <summary>
    /// Binds and checks the "Storage" section. The API refuses to start with addresses that aren't http(s), or with a
    /// lifecycle expiry so short that storage would delete files of bundles that are still live. The calculated
    /// expiry follows the longest a bundle may live (UploadLimits:MaxExpiryHours).
    /// </summary>
    public static IServiceCollection AddFileHolderStorageOptions(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<StorageOptions>()
            .Bind(configuration.GetSection(StorageOptions.SectionName))
            .PostConfigure<IOptions<UploadLimitsOptions>>((o, limits) => o.UseMaxExpiryHours(limits.Value.MaxExpiryHours))
            .ValidateDataAnnotations()
            .Validate(o => S3ClientFactory.IsHttpOrHttps(o.ServiceUrl) && S3ClientFactory.IsHttpOrHttps(o.PublicBaseUrl),
                "Storage:ServiceUrl and Storage:PublicBaseUrl must be absolute http:// or https:// URLs.")
            .ValidateOnStart();
        services.AddSingleton<IValidateOptions<StorageOptions>, LifecycleExpiryValidator>();
        return services;
    }

    private sealed class LifecycleExpiryValidator : IValidateOptions<StorageOptions>
    {
        public ValidateOptionsResult Validate(string? name, StorageOptions options) =>
            options.LifecycleExpiryDays is null || options.LifecycleExpiryDays >= options.CalculatedLifecycleExpiryDays
                ? ValidateOptionsResult.Success
                : ValidateOptionsResult.Fail(
                    $"Storage:LifecycleExpiryDays is below {options.CalculatedLifecycleExpiryDays}: storage would delete files of " +
                    "bundles that are still live. Raise it, or leave it unset to use the value calculated from the app's timings.");
    }
}
