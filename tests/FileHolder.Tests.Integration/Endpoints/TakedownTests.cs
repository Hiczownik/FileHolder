using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Amazon.S3.Model;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>
/// Takedown (#82): the owner removes a bundle through the admin port. Its files go at once, downloads in progress
/// stop, its link says it was removed, and the record of why stays.
/// </summary>
public class TakedownTests(ServiceModesFactory factory) : IClassFixture<ServiceModesFactory>
{
    private readonly HttpClient _client = factory.CreateClient();
    private readonly HttpClient _admin = factory.CreateAdminClient();

    /// <summary>A live bundle with one file, straight into the database, as confirm leaves it.</summary>
    private async Task<FileGroup> SeedBundleAsync(string storageKeyHint = "file", int? maxDownloads = 5, DateTime? storagePurgedAt = null)
    {
        var group = new FileGroup
        {
            ShareToken = Guid.NewGuid().ToString("N")[..8],
            Title = "Suspicious invoice",
            ExpiresAt = factory.Clock.UtcNow.AddHours(24),
            MaxDownloads = maxDownloads,
            IsDeleted = storagePurgedAt.HasValue,
            DeletedAt = storagePurgedAt,
            StoragePurgedAt = storagePurgedAt,
            Files =
            [
                new SharedFile
                {
                    OriginalFileName = "invoice.pdf.exe.pdf",
                    StorageKey = $"uploads/{storageKeyHint}_{Guid.NewGuid():N}.pdf",
                    ContentType = "application/pdf",
                    SizeBytes = 2048,
                },
            ],
        };

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.FileGroups.Add(group);
        await db.SaveChangesAsync();
        return group;
    }

    private async Task<Guid> SeedDownloadSessionAsync(FileGroup group)
    {
        var session = new DownloadSession
        {
            FileGroupId = group.Id,
            CreatedAt = factory.Clock.UtcNow,
            ExpiresAt = factory.Clock.UtcNow.AddHours(6),
        };
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        db.DownloadSessions.Add(session);
        await db.SaveChangesAsync();
        return session.Id;
    }

    private Task<HttpResponseMessage> TakeDownAsync(string shareToken, string reason = "phishing report from abuse@") =>
        _admin.PostAsJsonAsync("/admin/takedown", new TakedownRequestDto(shareToken, reason, "owner"));

    private async Task<FileGroup> LoadAsync(Guid id)
    {
        using var scope = factory.Services.CreateScope();
        return await scope.ServiceProvider.GetRequiredService<AppDbContext>().FileGroups
            .AsNoTracking().Include(g => g.Files).SingleAsync(g => g.Id == id);
    }

    private static async Task ShouldSayRemovedAsync(HttpResponseMessage response)
    {
        response.StatusCode.Should().Be(HttpStatusCode.Gone);
        var problem = await response.Content.ReadFromJsonAsync<JsonElement>();
        problem.GetProperty("title").GetString().Should().Be("Link Removed");
        problem.GetProperty("detail").GetString().Should().Be("This bundle was removed by FileHolder.");
        problem.GetProperty("removed").GetBoolean().Should().BeTrue();
    }

    [Fact]
    public async Task ATakedown_DeletesTheFilesAtOnce_AndLeavesATombstoneThatSaysRemoved()
    {
        var group = await SeedBundleAsync();
        var storageKey = group.Files.Single().StorageKey;
        factory.MockS3Client.ClearReceivedCalls();

        var response = await TakeDownAsync(group.ShareToken);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await response.Content.ReadFromJsonAsync<TakedownResponseDto>();
        result!.AlreadyTakenDown.Should().BeFalse();
        result.FilesDeleted.Should().Be(1);
        result.FilesNotYetDeleted.Should().Be(0);
        result.Record.Should().BeEquivalentTo(new TakedownRecordDto(
            group.ShareToken, factory.Clock.UtcNow, "phishing report from abuse@", "owner", 1, 2048, false),
            options => options.Using<DateTime>(ctx => ctx.Subject.Should().BeCloseTo(ctx.Expectation, TimeSpan.FromMilliseconds(1))).WhenTypeIs<DateTime>());

        await factory.MockS3Client.Received(1).DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req.Objects.Any(o => o.Key == storageKey)), Arg.Any<CancellationToken>());

        var tombstone = await LoadAsync(group.Id);
        tombstone.IsDeleted.Should().BeTrue();
        tombstone.StoragePurgedAt.Should().NotBeNull();
        tombstone.TakenDownAt.Should().NotBeNull("the link keeps saying it was removed");
        tombstone.Title.Should().BeNull();
        tombstone.Files.Should().BeEmpty();
    }

    [Fact]
    public async Task ARemovedLink_Answers410Removed_EverywhereARecipientCouldAsk()
    {
        var group = await SeedBundleAsync();
        await TakeDownAsync(group.ShareToken);

        await ShouldSayRemovedAsync(await _client.GetAsync($"/api/v1/files/{group.ShareToken}"));
        await ShouldSayRemovedAsync(await _client.PostAsJsonAsync($"/api/v1/files/{group.ShareToken}/unlock", new DownloadRequestDto("guess")));
        await ShouldSayRemovedAsync(await _client.PostAsJsonAsync($"/api/v1/files/{group.ShareToken}/downloads", new DownloadRequestDto(null)));
        await ShouldSayRemovedAsync(await _client.PostAsJsonAsync($"/api/v1/files/{group.ShareToken}/download-all", new DownloadRequestDto(null)));
    }

    [Fact]
    public async Task ATakedown_ClearsTheCachedBundle_SoItsPageDoesntKeepShowingIt()
    {
        var group = await SeedBundleAsync();
        (await _client.GetAsync($"/api/v1/files/{group.ShareToken}")).StatusCode.Should().Be(HttpStatusCode.OK);

        await TakeDownAsync(group.ShareToken);

        await ShouldSayRemovedAsync(await _client.GetAsync($"/api/v1/files/{group.ShareToken}"));
    }

    [Fact]
    public async Task ATakedown_StopsADownloadInProgress()
    {
        var group = await SeedBundleAsync();
        var sessionId = await SeedDownloadSessionAsync(group);
        var fileId = group.Files.Single().Id;
        (await _client.PostAsJsonAsync($"/api/v1/files/{group.ShareToken}/download/{fileId}", new DownloadRequestDto(null, sessionId)))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        await TakeDownAsync(group.ShareToken);

        (await _client.PostAsJsonAsync($"/api/v1/files/{group.ShareToken}/download/{fileId}", new DownloadRequestDto(null, sessionId)))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await _client.GetAsync($"/api/v1/files/{group.ShareToken}/download-all?downloadSessionId={sessionId}"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task WhenStorageFails_TheBundleIsStillClosed_AndThePurgeRetriesWithoutWaitingForGraceOrSessions()
    {
        // The S3 mock fails to delete keys containing "delete_fail".
        var group = await SeedBundleAsync("delete_fail");
        var sessionId = await SeedDownloadSessionAsync(group);
        var storageKey = group.Files.Single().StorageKey;

        var result = await (await TakeDownAsync(group.ShareToken)).Content.ReadFromJsonAsync<TakedownResponseDto>();

        result!.FilesDeleted.Should().Be(0);
        result.FilesNotYetDeleted.Should().Be(1);
        (await LoadAsync(group.Id)).StoragePurgedAt.Should().BeNull("its file is still in storage");
        await ShouldSayRemovedAsync(await _client.GetAsync($"/api/v1/files/{group.ShareToken}"));
        (await _client.PostAsJsonAsync($"/api/v1/files/{group.ShareToken}/download/{group.Files.Single().Id}",
            new DownloadRequestDto(null, sessionId))).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // The session would hold an expired bundle back for hours; a taken-down one goes in the next run.
        factory.MockS3Client.ClearReceivedCalls();
        using var scope = factory.Services.CreateScope();
        await scope.ServiceProvider.GetRequiredService<IStoragePurgeService>().PurgeExpiredFilesAsync();

        await factory.MockS3Client.Received(1).DeleteObjectsAsync(
            Arg.Is<DeleteObjectsRequest>(req => req.Objects.Any(o => o.Key == storageKey)), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task TakingDownTwice_ChangesNothing_AndReturnsTheFirstRecord()
    {
        var group = await SeedBundleAsync();
        await TakeDownAsync(group.ShareToken, "first report");

        var second = await TakeDownAsync(group.ShareToken, "second report");

        second.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await second.Content.ReadFromJsonAsync<TakedownResponseDto>();
        result!.AlreadyTakenDown.Should().BeTrue();
        result.Record.Reason.Should().Be("first report");

        using var scope = factory.Services.CreateScope();
        (await scope.ServiceProvider.GetRequiredService<AppDbContext>().Takedowns.CountAsync(t => t.FileGroupId == group.Id))
            .Should().Be(1);
    }

    [Fact]
    public async Task TheRecord_OutlivesTheTombstone_AndHoldsNoTitleOrFileNames()
    {
        var group = await SeedBundleAsync();
        await TakeDownAsync(group.ShareToken, "court order");

        using (var scope = factory.Services.CreateScope())
        {
            await scope.ServiceProvider.GetRequiredService<AppDbContext>().FileGroups.Where(g => g.Id == group.Id).ExecuteDeleteAsync();
        }

        var history = await _admin.GetFromJsonAsync<List<TakedownRecordDto>>("/admin/takedowns");
        var record = history!.Single(r => r.ShareToken == group.ShareToken);
        record.Reason.Should().Be("court order");
        JsonSerializer.Serialize(record).Should().NotContain("invoice").And.NotContain("Suspicious");
    }

    [Fact]
    public async Task ATakedown_Returns404_ForAnUnknownToken()
    {
        (await TakeDownAsync("zzzzzzzz")).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ATakedown_Returns409_WhenTheFilesWereAlreadyPurged()
    {
        var group = await SeedBundleAsync(storagePurgedAt: factory.Clock.UtcNow.AddHours(-1));

        (await TakeDownAsync(group.ShareToken)).StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Theory]
    [InlineData("", "a reason")]
    [InlineData("abcd1234", "")]
    public async Task ATakedown_NeedsATokenAndAReason(string shareToken, string reason)
    {
        (await _admin.PostAsJsonAsync("/admin/takedown", new TakedownRequestDto(shareToken, reason)))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Takedown_IsAnAdminEndpoint()
    {
        var group = await SeedBundleAsync();

        (await _client.PostAsJsonAsync("/admin/takedown", new TakedownRequestDto(group.ShareToken, "x")))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await LoadAsync(group.Id)).IsTakenDown.Should().BeFalse();
    }
}
