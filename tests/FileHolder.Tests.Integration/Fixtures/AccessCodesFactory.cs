namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// The API with access codes on (#169): uploads without a code get 10 MB and 1 hour, with one 250 MB and 24 hours.
/// A <see cref="ServiceModesFactory"/>, for its admin port and token and its clock. Its own fixture and database.
/// </summary>
public class AccessCodesFactory : ServiceModesFactory
{
    public const long MiB = 1024 * 1024;
    public const long WithCodeBytes = 250 * MiB;
    public const int WithCodeHours = 24;
    public const long WithoutCodeBytes = 10 * MiB;
    public const int WithoutCodeHours = 1;

    protected override IReadOnlyDictionary<string, string?> Settings => new Dictionary<string, string?>(base.Settings)
    {
        ["UploadLimits:MaxBundleSizeBytes"] = WithCodeBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["UploadLimits:MaxExpiryHours"] = WithCodeHours.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["UploadLimits:WithoutCodeMaxBundleSizeBytes"] = WithoutCodeBytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
        ["UploadLimits:WithoutCodeMaxExpiryHours"] = WithoutCodeHours.ToString(System.Globalization.CultureInfo.InvariantCulture),
    };
}
