using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public interface IBundleStreamService
{
    Task<AcquireLeaseResult> AcquireLeaseAsync(
        string shareToken,
        string? password,
        string? existingLeaseToken,
        CancellationToken ct = default
    );

    Task StreamArchiveAsync(
        IEnumerable<BundleFileEntry> files,
        Stream destinationStream,
        CancellationToken ct = default
    );

    Task FinalizeLeaseAsync(
        string leaseToken,
        Guid fileGroupId,
        string shareToken,
        CancellationToken ct = default
    );

    Task ReleaseLeaseAsync(
        string leaseToken,
        Guid fileGroupId,
        CancellationToken ct = default
    );
}