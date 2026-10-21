namespace FileHolder.Core.Configuration;

/// <summary>
/// How long a bundle may be set to live. The validators enforce it, and the storage safety net is sized from it
/// (<see cref="StorageSafetyNet"/>), so raising it raises the storage lifecycle rule too.
/// </summary>
public static class BundleLimits
{
    public const int MinExpiryHours = 1;
    public const int MaxExpiryHours = 168;

    public static readonly TimeSpan MaxExpiry = TimeSpan.FromHours(MaxExpiryHours);
}
