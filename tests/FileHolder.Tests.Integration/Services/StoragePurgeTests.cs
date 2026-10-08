using Amazon.S3.Model;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
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
            Arg.Is<AbortMultipartUploadRequest>(r => r.UploadId == targetUploadId && r.Key == targetStorageKey),
            Arg.Any<CancellationToken>()
        );

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var session = await dbContext.MultipartUploadSessions.FirstOrDefaultAsync(s => s.UploadId == targetUploadId);
            session.Should().NotBeNull();
            session!.IsAborted.Should().BeTrue();
        }
    }
}