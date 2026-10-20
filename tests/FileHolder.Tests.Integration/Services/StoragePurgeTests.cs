using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Services;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;

namespace FileHolder.Tests.Integration.Services;

public class StoragePurgeTests(CustomWebApplicationFactory factory)
    : IClassFixture<CustomWebApplicationFactory>
{
    [Fact]
    public async Task PurgeExpiredFilesAsync_AtomicallyDeletesS3Objects_AndSoftDeletesDatabaseRecords()
    {
        // Isolate mock call history before running assertions
        factory.MockS3Client.ClearReceivedCalls();

        Guid groupAId;
        Guid groupBId;
        Guid groupCId;

        using (var seedScope = factory.Services.CreateScope())
        {
            var dbContext = seedScope.ServiceProvider.GetRequiredService<AppDbContext>();

            // Group A: Expired by time
            var groupA = new FileGroup
            {
                ShareToken = "purge_a_" + Guid.NewGuid().ToString("N")[..8],
                Title = "Expired Time Bundle A",
                ExpiresAt = DateTime.UtcNow.AddHours(-2),
                DownloadCount = 0,
                MaxDownloads = 10,
                IsDeleted = false,
                Files = new List<SharedFile>
                {
                    new()
                    {
                        OriginalFileName = "purge_a.pdf",
                        StorageKey = "uploads/purge_a.pdf",
                        ContentType = "application/pdf",
                        SizeBytes = 1024
                    }
                }
            };

            // Group B: Exhausted downloads quota
            var groupB = new FileGroup
            {
                ShareToken = "purge_b_" + Guid.NewGuid().ToString("N")[..8],
                Title = "Exhausted Quota Bundle B",
                ExpiresAt = DateTime.UtcNow.AddHours(24),
                DownloadCount = 1,
                MaxDownloads = 1,
                IsDeleted = false,
                Files = new List<SharedFile>
                {
                    new()
                    {
                        OriginalFileName = "purge_b.png",
                        StorageKey = "uploads/purge_b.png",
                        ContentType = "image/png",
                        SizeBytes = 2048
                    }
                }
            };

            // Group C: Active & Valid Control Group
            var groupC = new FileGroup
            {
                ShareToken = "keep_c_" + Guid.NewGuid().ToString("N")[..8],
                Title = "Active Control Bundle C",
                ExpiresAt = DateTime.UtcNow.AddHours(24),
                DownloadCount = 0,
                MaxDownloads = 10,
                IsDeleted = false,
                Files = new List<SharedFile>
                {
                    new()
                    {
                        OriginalFileName = "keep_c.pdf",
                        StorageKey = "uploads/keep_c.pdf",
                        ContentType = "application/pdf",
                        SizeBytes = 4096
                    }
                }
            };

            dbContext.FileGroups.AddRange(groupA, groupB, groupC);
            await dbContext.SaveChangesAsync();

            groupAId = groupA.Id;
            groupBId = groupB.Id;
            groupCId = groupC.Id;
        }

        // Execute purge operation
        int purgedCount;
        using (var purgeScope = factory.Services.CreateScope())
        {
            var purgeService = purgeScope.ServiceProvider.GetRequiredService<IStoragePurgeService>();
            purgedCount = await purgeService.PurgeExpiredFilesAsync(CancellationToken.None);
        }

        purgedCount.Should().Be(2);

        // Verify Database Invariants
        using (var verifyScope = factory.Services.CreateScope())
        {
            var verifyDb = verifyScope.ServiceProvider.GetRequiredService<AppDbContext>();

            var groupARecord = await verifyDb.FileGroups.AsNoTracking().FirstAsync(g => g.Id == groupAId);
            var groupBRecord = await verifyDb.FileGroups.AsNoTracking().FirstAsync(g => g.Id == groupBId);
            var groupCRecord = await verifyDb.FileGroups.AsNoTracking().FirstAsync(g => g.Id == groupCId);

            groupARecord.IsDeleted.Should().BeTrue();
            groupBRecord.IsDeleted.Should().BeTrue();
            groupCRecord.IsDeleted.Should().BeFalse();

            // S3 Deletion Invariants: Group A and B keys deleted, Control Group C kept untouched
            await factory.MockS3Client.Received(1).DeleteObjectsAsync(
                Arg.Is<DeleteObjectsRequest>(req =>
                    req != null &&
                    req.Objects.Any(o => o.Key == "uploads/purge_a.pdf") &&
                    req.Objects.Any(o => o.Key == "uploads/purge_b.png") &&
                    req.Objects.All(o => o.Key != "uploads/keep_c.pdf")
                ),
                Arg.Any<CancellationToken>()
            );

            // Cache Invalidation Check
            var fileGroupService = verifyScope.ServiceProvider.GetRequiredService<IFileGroupService>();
            var metadataA = await fileGroupService.GetGroupMetadataByTokenAsync(groupARecord.ShareToken);
            (metadataA == null || metadataA.IsExpired).Should().BeTrue();
        }
    }

    [Fact]
    public async Task PurgeExpiredFilesAsync_WhenQuotaExhaustedByDownloadSession_WaitsForGracePeriodBeforeDeleting()
    {
        var storageKey = "uploads/grace_" + Guid.NewGuid().ToString("N") + ".pdf";
        var group = await SeedGroupAsync("grace_", storageKey, maxDownloads: 1);

        // Consume the last download through the real session + single-file download path
        Guid sessionId;
        using (var scope = factory.Services.CreateScope())
        {
            var sessionService = scope.ServiceProvider.GetRequiredService<IDownloadSessionService>();
            var opened = await sessionService.OpenSessionAsync(group.ShareToken, null);
            opened.Status.Should().Be(OpenDownloadSessionStatus.Success);
            sessionId = opened.Session!.DownloadSessionId;

            var fileGroupService = scope.ServiceProvider.GetRequiredService<IFileGroupService>();
            var result = await fileGroupService.CreatePresignedDownloadUrlAsync(group.ShareToken, group.Files.First().Id, sessionId);
            result.Status.Should().Be(DownloadUrlStatus.Success);
        }

        factory.MockS3Client.ClearReceivedCalls();
        await RunPurgeAsync();

        var record = await LoadGroupAsync(group.Id);
        record.IsDeleted.Should().BeTrue();
        record.DeletedAt.Should().NotBeNull();
        record.StoragePurgedAt.Should().BeNull("the active session and the presigned URL it issued must remain usable");

        await factory.MockS3Client.DidNotReceive().DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req != null && req.Objects.Any(o => o.Key == storageKey)),
            Arg.Any<CancellationToken>());

        // The last download's session keeps working even though the group is now closed to new downloads
        using (var scope = factory.Services.CreateScope())
        {
            var fileGroupService = scope.ServiceProvider.GetRequiredService<IFileGroupService>();
            var result = await fileGroupService.CreatePresignedDownloadUrlAsync(group.ShareToken, group.Files.First().Id, sessionId);
            result.Status.Should().Be(DownloadUrlStatus.Success);
        }
    }

    [Fact]
    public async Task PurgeExpiredFilesAsync_DeletesAbandonedUploadsPastGrace_AndKeepsPendingOnes()
    {
        var now = DateTime.UtcNow;
        var id = Guid.NewGuid().ToString("N");
        var pastGrace = now - UploadTimings.PendingUploadPurgeGrace - TimeSpan.FromMinutes(5);

        var abandoned = NewPendingUpload($"uploads/abandoned_{id}.pdf", pastGrace);
        var failing = NewPendingUpload($"uploads/delete_fail_abandoned_{id}.pdf", pastGrace);
        var withinGrace = NewPendingUpload($"uploads/within_grace_{id}.pdf", now - TimeSpan.FromMinutes(5));
        var active = NewPendingUpload($"uploads/active_{id}.pdf", now + TimeSpan.FromHours(1));

        using (var seedScope = factory.Services.CreateScope())
        {
            var dbContext = seedScope.ServiceProvider.GetRequiredService<AppDbContext>();
            dbContext.PendingUploads.AddRange(abandoned, failing, withinGrace, active);
            await dbContext.SaveChangesAsync();
        }

        factory.MockS3Client.ClearReceivedCalls();
        await RunPurgeAsync();

        await factory.MockS3Client.Received(1).DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req =>
                req != null &&
                req.Objects.Any(o => o.Key == abandoned.StorageKey) &&
                req.Objects.Any(o => o.Key == failing.StorageKey) &&
                req.Objects.All(o => o.Key != withinGrace.StorageKey && o.Key != active.StorageKey)),
            Arg.Any<CancellationToken>());

        using (var verifyScope = factory.Services.CreateScope())
        {
            var dbContext = verifyScope.ServiceProvider.GetRequiredService<AppDbContext>();
            var remaining = await dbContext.PendingUploads
                .Where(p => p.StorageKey.Contains(id))
                .Select(p => p.StorageKey)
                .ToListAsync();

            // The failed delete stays behind to be retried; the recent ones are untouched.
            remaining.Should().BeEquivalentTo(failing.StorageKey, withinGrace.StorageKey, active.StorageKey);

            await dbContext.PendingUploads.Where(p => p.StorageKey.Contains(id)).ExecuteDeleteAsync();
        }
    }

    private static PendingUpload NewPendingUpload(string storageKey, DateTime expiresAt) => new()
    {
        UploadToken = Guid.NewGuid().ToString("N"),
        StorageKey = storageKey,
        FileName = Path.GetFileName(storageKey),
        ContentType = "application/pdf",
        SizeBytes = 1024,
        CreatedAt = expiresAt - UploadTimings.PendingUploadLifetime,
        ExpiresAt = expiresAt
    };

    [Fact]
    public async Task PurgeExpiredFilesAsync_RemovesDownloadSessionsPastRetention_AndKeepsRecentOnes()
    {
        var group = await SeedGroupAsync("sess_", "uploads/sess_" + Guid.NewGuid().ToString("N") + ".pdf", maxDownloads: 10);
        var now = DateTime.UtcNow;

        var staleSession = new DownloadSession
        {
            FileGroupId = group.Id,
            CreatedAt = now - DownloadTimings.ExpiredSessionRetention - TimeSpan.FromHours(1),
            ExpiresAt = now - DownloadTimings.ExpiredSessionRetention - TimeSpan.FromMinutes(1)
        };
        var recentSession = new DownloadSession
        {
            FileGroupId = group.Id,
            CreatedAt = now - TimeSpan.FromHours(1),
            ExpiresAt = now - TimeSpan.FromMinutes(30)
        };

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            dbContext.DownloadSessions.AddRange(staleSession, recentSession);
            await dbContext.SaveChangesAsync();
        }

        await RunPurgeAsync();

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var remainingIds = await dbContext.DownloadSessions
                .Where(s => s.FileGroupId == group.Id)
                .Select(s => s.Id)
                .ToListAsync();

            remainingIds.Should().BeEquivalentTo([recentSession.Id]);
        }
    }

    [Fact]
    public async Task PurgeExpiredFilesAsync_WhenDeletedGroupIsPastGracePeriod_DeletesObjectsAndRecordsPurge()
    {
        var storageKey = "uploads/orphan_" + Guid.NewGuid().ToString("N") + ".pdf";
        var group = await SeedGroupAsync("orphan_", storageKey, maxDownloads: 1, downloadCount: 1,
            deletedAt: DateTime.UtcNow - StoragePurgeService.DeletionGracePeriod - TimeSpan.FromMinutes(1));

        factory.MockS3Client.ClearReceivedCalls();
        await RunPurgeAsync();

        var record = await LoadGroupAsync(group.Id);
        record.StoragePurgedAt.Should().NotBeNull();

        await factory.MockS3Client.Received(1).DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req != null && req.Objects.Any(o => o.Key == storageKey)),
            Arg.Any<CancellationToken>());

        // Already purged groups are not picked up again
        factory.MockS3Client.ClearReceivedCalls();
        await RunPurgeAsync();

        await factory.MockS3Client.DidNotReceive().DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req != null && req.Objects.Any(o => o.Key == storageKey)),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PurgeExpiredFilesAsync_WaitsForALongDownloadStillRunning_ThenDeletes()
    {
        // The bundle's last download was counted (and the bundle closed) long ago, but that download is still
        // running, e.g. a 5 GB ZIP on a slow connection: its session hasn't ended.
        var storageKey = "uploads/longdl_" + Guid.NewGuid().ToString("N") + ".pdf";
        var closedLongAgo = DateTime.UtcNow - TimeSpan.FromHours(2);
        var group = await SeedGroupAsync("longdl_", storageKey, maxDownloads: 1, downloadCount: 1, deletedAt: closedLongAgo);
        var session = new DownloadSession { FileGroupId = group.Id, CreatedAt = closedLongAgo, ExpiresAt = DateTime.UtcNow.AddHours(4) };
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            dbContext.DownloadSessions.Add(session);
            await dbContext.SaveChangesAsync();
        }

        factory.MockS3Client.ClearReceivedCalls();
        await RunPurgeAsync();

        (await LoadGroupAsync(group.Id)).StoragePurgedAt.Should().BeNull("the download that is still running needs the files");
        await factory.MockS3Client.DidNotReceive().DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req != null && req.Objects.Any(o => o.Key == storageKey)),
            Arg.Any<CancellationToken>());

        // Once the session has ended, and the last URL it could have issued has expired too, the files go.
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.DownloadSessions
                .Where(s => s.Id == session.Id)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ExpiresAt, DateTime.UtcNow - StoragePurgeService.DeletionGracePeriod - TimeSpan.FromMinutes(1)));
        }

        await RunPurgeAsync();

        (await LoadGroupAsync(group.Id)).StoragePurgedAt.Should().NotBeNull();
        await factory.MockS3Client.Received(1).DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req != null && req.Objects.Any(o => o.Key == storageKey)),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task PurgeExpiredFilesAsync_WhenStorageDeleteFails_LeavesGroupPendingForRetry()
    {
        var storageKey = "uploads/delete_fail_" + Guid.NewGuid().ToString("N") + ".pdf";
        var group = await SeedGroupAsync("fail_", storageKey, maxDownloads: 1, downloadCount: 1,
            deletedAt: DateTime.UtcNow - StoragePurgeService.DeletionGracePeriod - TimeSpan.FromMinutes(1));

        await RunPurgeAsync();

        var record = await LoadGroupAsync(group.Id);
        record.IsDeleted.Should().BeTrue();
        record.StoragePurgedAt.Should().BeNull();
    }

    private async Task<FileGroup> SeedGroupAsync(
        string tokenPrefix,
        string storageKey,
        int maxDownloads,
        int downloadCount = 0,
        DateTime? deletedAt = null)
    {
        var group = new FileGroup
        {
            ShareToken = tokenPrefix + Guid.NewGuid().ToString("N")[..8],
            ExpiresAt = DateTime.UtcNow.AddHours(24),
            MaxDownloads = maxDownloads,
            DownloadCount = downloadCount,
            IsDeleted = deletedAt.HasValue,
            DeletedAt = deletedAt,
            Files = new List<SharedFile>
            {
                new()
                {
                    OriginalFileName = "file.pdf",
                    StorageKey = storageKey,
                    ContentType = "application/pdf",
                    SizeBytes = 1024
                }
            }
        };

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        dbContext.FileGroups.Add(group);
        await dbContext.SaveChangesAsync();
        return group;
    }

    private async Task RunPurgeAsync()
    {
        using var scope = factory.Services.CreateScope();
        var purgeService = scope.ServiceProvider.GetRequiredService<IStoragePurgeService>();
        await purgeService.PurgeExpiredFilesAsync(CancellationToken.None);
    }

    private async Task<FileGroup> LoadGroupAsync(Guid groupId)
    {
        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await dbContext.FileGroups.AsNoTracking().FirstAsync(g => g.Id == groupId);
    }

    [Fact]
    public async Task PurgeExpiredFilesAsync_WhenIncompleteMultipartSessionsExpired_AbortsAndMarksAborted()
    {
        string targetUploadId = "expired_upload_id_" + Guid.NewGuid().ToString("N");
        string targetStorageKey = "uploads/expired_part_file.bin";

        var utcNow = DateTime.UtcNow;

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();

            var expiredSession = new MultipartUploadSession
            {
                UploadToken = Guid.NewGuid().ToString("N"),
                UploadId = targetUploadId,
                StorageKey = targetStorageKey,
                FileName = "expired_part_file.bin",
                ContentType = "application/octet-stream",
                TotalSizeBytes = 100 * 1024 * 1024,
                PartSizeBytes = 16 * 1024 * 1024,
                TotalParts = 7,
                IsCompleted = false,
                IsAborted = false,
                ExpiresAt = DateTime.SpecifyKind(utcNow.AddHours(-2), DateTimeKind.Utc),
                CreatedAt = DateTime.SpecifyKind(utcNow.AddHours(-26), DateTimeKind.Utc)
            };

            dbContext.MultipartUploadSessions.Add(expiredSession);
            await dbContext.SaveChangesAsync();
        }

        factory.MockS3Client.ClearReceivedCalls();

        using (var scope = factory.Services.CreateScope())
        {
            var purgeService = scope.ServiceProvider.GetRequiredService<IStoragePurgeService>();
            await purgeService.PurgeExpiredFilesAsync(CancellationToken.None);
        }

        await factory.MockS3Client.Received(1).AbortMultipartUploadAsync(
            Arg.Is<AbortMultipartUploadRequest>(r => r != null && r.UploadId == targetUploadId && r.Key == targetStorageKey),
            Arg.Any<CancellationToken>()
        );

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var session = await dbContext.MultipartUploadSessions.FirstOrDefaultAsync(s => s.UploadId == targetUploadId);
            session.Should().NotBeNull();
            session.IsAborted.Should().BeTrue();
        }
    }
}