namespace FileHolder.Core.Configuration;

/// <summary>
/// The longest and shortest a bundle can ever be set to live. A deployment can lower the maximum with
/// UploadLimits:MaxExpiryHours (<see cref="UploadLimitsOptions.MaxExpiryHours"/>), which the validators enforce and
/// the storage safety net is sized from (<see cref="StorageSafetyNet"/>).
/// </summary>
public static class BundleLimits
{
    public const int MinExpiryHours = 1;
    public const int MaxExpiryHours = 168;

    public static readonly TimeSpan MaxExpiry = TimeSpan.FromHours(MaxExpiryHours);
}
