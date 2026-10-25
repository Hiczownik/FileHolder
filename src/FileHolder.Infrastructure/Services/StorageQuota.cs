using FileHolder.Core.Configuration;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace FileHolder.Infrastructure.Services;

/// <summary>How much storage the app's files take up, as far as the database knows.</summary>
/// <param name="BytesInUse">Bundles whose files haven't been purged yet, plus uploads presigned but not confirmed.</param>
public sealed record StorageUsage(long BytesInUse);

public static class StorageUsageQuery
{
    /// <summary>
    /// Counted from the sizes declared at presign (upload URLs are signed for them, so storage holds no more), not by
    /// listing the bucket. Deleted bundles count until the purge has removed their files, and pending uploads until
    /// they're confirmed or the purge drops them. Single-part files are copied at confirm and their original is left
    /// to the purge, so for a while those count once but take up twice: the quota is a cap on what's accepted, with
    /// that much slack, not an exact meter.
    /// </summary>
    public static async Task<StorageUsage> ReadAsync(AppDbContext dbContext, CancellationToken ct)
    {
        var files = await dbContext.SharedFiles.AsNoTracking()
            .Where(f => f.FileGroup.StoragePurgedAt == null)
            .SumAsync(f => (long?)f.SizeBytes, ct) ?? 0;
        var pending = await dbContext.PendingUploads.AsNoTracking()
            .SumAsync(p => (long?)p.SizeBytes, ct) ?? 0;
        return new StorageUsage(files + pending);
    }
}

/// <summary>
/// The global storage quota (UploadLimits:GlobalQuotaBytes): presign refuses a bundle that would take storage past
/// it, so a public deployment's storage, and its bill, can't grow without bound. Off when unset.
/// Uploads already presigned still finish, and space comes back as the purge removes expired bundles. Two presigns
/// at the same moment can both fit and together overshoot by at most one bundle each: a soft cap.
/// </summary>
public sealed class StorageQuota(AppDbContext dbContext, IOptions<UploadLimitsOptions> uploadLimits)
{
    /// <summary>Whether a bundle of <paramref name="bytes"/> fits under the quota, or true when there is none.</summary>
    public async Task<bool> HasRoomForAsync(long bytes, CancellationToken ct = default)
    {
        if (uploadLimits.Value.GlobalQuotaBytes is not { } quota)
        {
            return true;
        }

        var usage = await StorageUsageQuery.ReadAsync(dbContext, ct);
        return (Int128)usage.BytesInUse + bytes <= quota;
    }
}
