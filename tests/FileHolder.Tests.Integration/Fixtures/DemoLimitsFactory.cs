namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// The API with a public demo's upload limits (#148): 250 MB bundles, 24 h at most, and a 1 GB global storage quota.
/// A <see cref="HealthChecksFactory"/>, so tests can move its clock past the health checks' 30-second cache. Its own
/// fixture (and database), since the quota counts every bundle in it.
/// </summary>
public class DemoLimitsFactory : HealthChecksFactory
{
    public const long MiB = 1024 * 1024;
    public const long MaxBundleSizeBytes = 250 * MiB;
    public const int MaxExpiryHours = 24;
    public const long GlobalQuotaBytes = 1024 * MiB;

    protected override IReadOnlyDictionary<string, string?> Settings => new Dictionary<string, string?>
    {
        ["UploadLimits:MaxBundleSizeBytes"] = MaxBundleSizeBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["UploadLimits:MaxExpiryHours"] = MaxExpiryHours.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["UploadLimits:GlobalQuotaBytes"] = GlobalQuotaBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
    };
}
