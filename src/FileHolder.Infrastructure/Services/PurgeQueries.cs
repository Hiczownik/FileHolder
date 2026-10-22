using FileHolder.Core.Entities;
using FileHolder.Infrastructure.Data;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// Which bundles the purge deletes, in one place, so the purge and the health check that watches it (purge_backlog)
/// can never disagree about it.
/// </summary>
public static class PurgeQueries
{
    /// <summary>
    /// Bundles whose files are due for deletion at <paramref name="now"/>: still holding their files, and expired or
    /// closed (deleted, or out of downloads) at least <see cref="StoragePurgeService.DeletionGracePeriod"/> ago. A
    /// closed group's last download may still be running: its session can last hours after the group closed, and a
    /// URL issued near either end stays valid a little longer, so a group with a session that recent waits too.
    /// </summary>
    public static IQueryable<FileGroup> DueForPurge(this IQueryable<FileGroup> groups, AppDbContext dbContext, DateTime now)
    {
        var graceCutoff = now - StoragePurgeService.DeletionGracePeriod;

        return groups
            .Where(g => g.StoragePurgedAt == null && (
                (g.ExpiresAt != null && g.ExpiresAt <= graceCutoff) ||
                ((g.IsDeleted || (g.MaxDownloads != null && g.DownloadCount >= g.MaxDownloads)) &&
                 (g.DeletedAt == null || g.DeletedAt <= graceCutoff))
            ))
            .Where(g => !dbContext.DownloadSessions.Any(s => s.FileGroupId == g.Id && s.ExpiresAt > graceCutoff));
    }
}
