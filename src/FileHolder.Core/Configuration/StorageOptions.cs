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
    /// <see cref="CalculatedLifecycleExpiryDays"/>. A value below that would let storage delete files of bundles that
    /// are still live, so the API refuses to start with one.
    /// </summary>
    public int? LifecycleExpiryDays { get; set; }

    private int _calculatedLifecycleExpiryDays = StorageSafetyNet.LifecycleExpiryDays;

    /// <summary>
    /// The expiry calculated from the app's timings and the longest a bundle may live (UploadLimits:MaxExpiryHours),
    /// set by <see cref="UseMaxExpiryHours"/>. Not read from configuration.
    /// </summary>
    public int CalculatedLifecycleExpiryDays => _calculatedLifecycleExpiryDays;

    /// <summary>Sizes the calculated expiry for bundles that live at most <paramref name="maxExpiryHours"/>.</summary>
    public void UseMaxExpiryHours(int maxExpiryHours) =>
        _calculatedLifecycleExpiryDays = StorageSafetyNet.LifecycleExpiryDaysForMaxExpiry(TimeSpan.FromHours(maxExpiryHours));

    /// <summary>The lifecycle expiry in effect: the configured one, or the calculated one.</summary>
    public int EffectiveLifecycleExpiryDays => LifecycleExpiryDays ?? CalculatedLifecycleExpiryDays;
}