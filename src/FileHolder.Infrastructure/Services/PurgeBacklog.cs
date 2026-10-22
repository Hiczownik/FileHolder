using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Infrastructure.Services;

/// <summary>Bundles the purge should have deleted by now, and since when the oldest of them is due.</summary>
/// <param name="OverdueGroups">How many bundles still hold their files past <see cref="HealthThresholds.PurgeOverdueAfter"/>.</param>
/// <param name="OldestOverdueSince">The earliest expiry or closing among them, when known (a bundle that ran out of downloads has none).</param>
public sealed record PurgeBacklog(int OverdueGroups, DateTime? OldestOverdueSince);

public static class PurgeBacklogQuery
{
    /// <summary>
    /// The bundles that were already due for purge <see cref="HealthThresholds.PurgeOverdueAfter"/> ago and still
    /// hold their files. Uses the purge's own rule (<see cref="PurgeQueries.DueForPurge"/>), asked about an earlier
    /// moment, and the filtered index on StoragePurgedAt IS NULL.
    /// </summary>
    public static async Task<PurgeBacklog> ReadAsync(AppDbContext dbContext, IDateTimeProvider dateTimeProvider, CancellationToken ct)
    {
        var dueBy = dateTimeProvider.UtcNow - HealthThresholds.PurgeOverdueAfter;
        var overdue = dbContext.FileGroups.AsNoTracking().DueForPurge(dbContext, dueBy);

        var count = await overdue.CountAsync(ct);
        var oldest = count == 0
            ? null
            : await overdue.MinAsync(g => g.DeletedAt != null && (g.ExpiresAt == null || g.DeletedAt < g.ExpiresAt) ? g.DeletedAt : g.ExpiresAt, ct);
        return new PurgeBacklog(count, oldest);
    }
}
