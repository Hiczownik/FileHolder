using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Services;

namespace FileHolder.Api.Configuration;

public static class StorageRegistration
{
    /// <summary>
    /// Binds and checks the "Storage" section. The API refuses to start with addresses that aren't http(s), or with a
    /// lifecycle expiry so short that storage would delete files of bundles that are still live.
    /// </summary>
    public static IServiceCollection AddFileHolderStorageOptions(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<StorageOptions>()
            .Bind(configuration.GetSection(StorageOptions.SectionName))
            .ValidateDataAnnotations()
            .Validate(o => S3ClientFactory.IsHttpOrHttps(o.ServiceUrl) && S3ClientFactory.IsHttpOrHttps(o.PublicBaseUrl),
                "Storage:ServiceUrl and Storage:PublicBaseUrl must be absolute http:// or https:// URLs.")
            .Validate(o => o.LifecycleExpiryDays is null || o.LifecycleExpiryDays >= StorageSafetyNet.LifecycleExpiryDays,
                $"Storage:LifecycleExpiryDays is below {StorageSafetyNet.LifecycleExpiryDays}: storage would delete files of bundles " +
                "that are still live. Raise it, or leave it unset to use the value calculated from the app's timings.")
            .ValidateOnStart();
        return services;
    }
}
