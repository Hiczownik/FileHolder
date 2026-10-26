using FileHolder.Core.Entities;

namespace FileHolder.Core.Configuration;

/// <summary>What a request does, as far as the <see cref="ServiceMode"/> is concerned.</summary>
public enum ServiceCapability
{
    /// <summary>Presign: a new upload.</summary>
    StartUpload,

    /// <summary>Multipart steps and confirm for an upload presign already approved, so it can finish.</summary>
    ContinueUpload,

    /// <summary>A bundle's details, and unlocking a password-protected one.</summary>
    ViewBundle,

    /// <summary>Opening a download session, which counts a download.</summary>
    StartDownload,

    /// <summary>File links and ZIPs for a download session already open, so it can finish.</summary>
    ContinueDownload
}

/// <summary>Which requests each <see cref="ServiceMode"/> lets through.</summary>
public static class ServiceModeRules
{
    /// <summary>How long Retry-After asks clients to wait when the mode has no <c>until</c> to go by.</summary>
    public static readonly TimeSpan DefaultRetryAfter = TimeSpan.FromMinutes(5);

    /// <summary>How long one API instance keeps using the mode it read; a change elsewhere shows within this.</summary>
    public static readonly TimeSpan CacheLifetime = TimeSpan.FromSeconds(5);

    public static bool Allows(ServiceMode mode, ServiceCapability capability) => mode switch
    {
        ServiceMode.Normal => true,
        ServiceMode.UploadsPaused => capability != ServiceCapability.StartUpload,
        ServiceMode.ReadOnly => capability is ServiceCapability.ViewBundle or ServiceCapability.ContinueDownload,
        _ => false,
    };
}
