using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IBundleStreamService
{
    /// <summary>
    /// Streams the group's files as a ZIP. With a download session this does not count as another
    /// download; without one it opens a new session, consuming one download.
    /// </summary>
    Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password,
        Guid? downloadSessionId,
        Stream destinationStream,
        Action<string>? onBeforeStream = null,
        CancellationToken ct = default);
}