using System.ComponentModel.DataAnnotations;

namespace FileHolder.Core.Configuration;

public class StorageOptions
{
    public const string SectionName = "Storage";

    [Required(ErrorMessage = "Storage:ServiceUrl is required.")]
    public string ServiceUrl { get; set; } = "http://localhost:9000";

    [Required(ErrorMessage = "Storage:PublicBaseUrl is required.")]
    public string PublicBaseUrl { get; set; } = "http://localhost:9000";

    // No defaults: credentials come from the environment (compose reads them from .env) or, for a local
    // `dotnet run`, from user secrets (README, Development).
    [Required(ErrorMessage = "Storage:AccessKey is required.")]
    public string AccessKey { get; set; } = string.Empty;

    [Required(ErrorMessage = "Storage:SecretKey is required.")]
    public string SecretKey { get; set; } = string.Empty;

    [Required(ErrorMessage = "Storage:BucketName is required.")]
    public string BucketName { get; set; } = "fileholder-bucket";

    /// <summary>
    /// Days after which storage deletes any object (the safety net's lifecycle rule). Leave unset to use
    /// <see cref="StorageSafetyNet.LifecycleExpiryDays"/>, calculated from the app's timings. A value below that would
    /// let storage delete files of bundles that are still live, so the API refuses to start with one.
    /// </summary>
    public int? LifecycleExpiryDays { get; set; }

    /// <summary>The lifecycle expiry in effect: the configured one, or the calculated one.</summary>
    public int EffectiveLifecycleExpiryDays => LifecycleExpiryDays ?? StorageSafetyNet.LifecycleExpiryDays;
}