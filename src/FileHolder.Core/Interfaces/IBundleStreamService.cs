using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IBundleStreamService
{
    Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password,
        Stream destinationStream,
        Action<string>? onBeforeStream = null,
        CancellationToken ct = default);

    Task<StreamZipResult> StreamBundleZipAsync(
        string shareToken,
        string? password,
        Stream destinationStream,
        CancellationToken ct = default);
}