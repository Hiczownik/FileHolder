using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using Amazon.S3.Model;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;

namespace FileHolder.Tests.Integration.Endpoints;

public class FileEndpointTests(CustomWebApplicationFactory factory) : IClassFixture<CustomWebApplicationFactory>
{
    private readonly HttpClient _client = factory.CreateClient();

    #region Helper Factory Methods

    private static CreatePresignedUrlRequestDto CreateValidPresignRequest() => new(
        Title: "Valid Group",
        Files: new List<FileItemInputDto>
        {
            new("architecture_diagram.pdf", "application/pdf", 1024)
        },
        ExpireInHours: 24,
        MaxDownloads: 10,
        Password: "ValidPassword123!"
    );

    /// <summary>
    /// Presigns the files, "uploads" them by seeding the S3 mock at their declared size, and returns
    /// the matching confirm request, so tests go through the same presign-then-confirm flow as the UI.
    /// </summary>
    private async Task<ConfirmUploadRequestDto> PresignAndUploadAsync(
        string title,
        List<FileItemInputDto> files,
        int? maxDownloads,
        string? password = null,
        bool isEncrypted = false)
    {
        var presignResponse = await _client.PostAsJsonAsync("/api/v1/files/presign",
            new CreatePresignedUrlRequestDto(title, files, 24, maxDownloads, password, isEncrypted));
        presignResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var presign = (await presignResponse.Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!;

        var confirmedFiles = presign.Items
            .Select((item, i) =>
            {
                factory.SeedS3Object(item.StorageKey, files[i].SizeBytes);
                return new ConfirmedFileItemDto(item.StorageKey, files[i].FileName, files[i].ContentType, files[i].SizeBytes);
            })
            .ToList();

        return new ConfirmUploadRequestDto(presign.UploadToken, title, confirmedFiles, 24, maxDownloads, password, isEncrypted);
    }

    private async Task<(string ShareToken, List<Guid> FileIds)> CreateBundleAsync(int fileCount, int? maxDownloads, string? password = null)
    {
        var files = Enumerable.Range(1, fileCount)
            .Select(i => new FileItemInputDto($"file_{i}.pdf", "application/pdf", 1024))
            .ToList();

        var confirmRequest = await PresignAndUploadAsync("Session Bundle", files, maxDownloads, password);
        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = (await confirmResponse.Content.ReadFromJsonAsync<string>())!;

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var fileIds = await dbContext.SharedFiles
            .Where(f => f.FileGroup.ShareToken == shareToken)
            .Select(f => f.Id)
            .ToListAsync();

        return (shareToken, fileIds);
    }

    private Task<HttpResponseMessage> OpenSessionAsync(string shareToken, string? password = null) =>
        _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/downloads", new DownloadRequestDto(password));

    private async Task<Guid> OpenSessionIdAsync(string shareToken, string? password = null)
    {
        var response = await OpenSessionAsync(shareToken, password);
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = await response.Content.ReadFromJsonAsync<DownloadSessionResponseDto>();
        return session!.DownloadSessionId;
    }

    private Task<HttpResponseMessage> RequestFileLinkAsync(string shareToken, Guid fileId, Guid? sessionId) =>
        _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download/{fileId}", new DownloadRequestDto(null, sessionId));

    private async Task<int> GetDownloadCountAsync(string shareToken)
    {
        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await dbContext.FileGroups
            .Where(g => g.ShareToken == shareToken)
            .Select(g => g.DownloadCount)
            .FirstAsync();
    }

    #endregion

    #region 1. Validation Boundary Tests ([Theory] Data-Driven)

    [Theory]
    // forbidden extensions
    [InlineData("script.sh", "application/x-sh", 1024, 24, 10, null)]
    [InlineData("library.dll", "application/octet-stream", 1024, 24, 10, null)]
    // file size: none, and past the 5 GB bundle limit
    [InlineData("document.pdf", "application/pdf", 0, 24, 10, null)]
    [InlineData("document.pdf", "application/pdf", 5L * 1024 * 1024 * 1024 + 1, 24, 10, null)]
    [InlineData("document.pdf", "application/pdf", long.MaxValue, 24, 10, null)]
    // content type: not a media type, or carrying header-breaking characters
    [InlineData("document.pdf", "application.pdf", 1024, 24, 10, null)]
    [InlineData("document.pdf", "text/html\r\nX-Evil: 1", 1024, 24, 10, null)]
    [InlineData("document.pdf", "text/ plain", 1024, 24, 10, null)]
    [InlineData("document.pdf", "/pdf", 1024, 24, 10, null)]
    // expiration limit
    [InlineData("document.pdf", "application/pdf", 1024, 0, 10, null)]
    [InlineData("document.pdf", "application/pdf", 1024, 200, 10, null)]
    // download limit
    [InlineData("document.pdf", "application/pdf", 1024, 24, 0, null)]
    [InlineData("document.pdf", "application/pdf", 1024, 24, 2000, null)]
    // password: too short, or only spaces (which would otherwise leave the bundle unprotected)
    [InlineData("document.pdf", "application/pdf", 1024, 24, 10, "123")]
    [InlineData("document.pdf", "application/pdf", 1024, 24, 10, "    ")]
    [InlineData("document.pdf", "application/pdf", 1024, 24, 10, "\t \t ")]
    public async Task GetPresignedUrl_Returns400BadRequest_WhenValidationFails(
        string fileName,
        string contentType,
        long sizeBytes,
        int expireInHours,
        int maxDownloads,
        string? password)
    {
        var request = new CreatePresignedUrlRequestDto(
            Title: "Test Group",
            Files: new List<FileItemInputDto> { new(fileName, contentType, sizeBytes) },
            ExpireInHours: expireInHours,
            MaxDownloads: maxDownloads,
            Password: password
        );

        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task GetPresignedUrl_Returns400badRequest_WhenFileListIsEmpty()
    {
        var request = CreateValidPresignRequest() with { Files = new List<FileItemInputDto>() };

        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    // forbidden extension renamed in after presign
    [InlineData("payload.exe", "uploads/{0}.pdf", 0, 24, 10, null)]
    // storage key outside the uploads prefix
    [InlineData("document.pdf", "secrets/{0}.pdf", 0, 24, 10, null)]
    [InlineData("document.pdf", "uploads/../{0}.pdf", 0, 24, 10, null)]
    // title longer than the column
    [InlineData("document.pdf", "uploads/{0}.pdf", 256, 24, 10, null)]
    // expiration limit
    [InlineData("document.pdf", "uploads/{0}.pdf", 0, 0, 10, null)]
    [InlineData("document.pdf", "uploads/{0}.pdf", 0, 100000, 10, null)]
    // download limit
    [InlineData("document.pdf", "uploads/{0}.pdf", 0, 24, 0, null)]
    [InlineData("document.pdf", "uploads/{0}.pdf", 0, 24, -5, null)]
    [InlineData("document.pdf", "uploads/{0}.pdf", 0, 24, 2000, null)]
    // password
    [InlineData("document.pdf", "uploads/{0}.pdf", 0, 24, 10, "123")]
    public async Task ConfirmUpload_Returns400BadRequest_WhenBundleSettingsBypassPresignValidation(
        string fileName,
        string storageKeyFormat,
        int titleLength,
        int expireInHours,
        int maxDownloads,
        string? password)
    {
        var storageKey = string.Format(System.Globalization.CultureInfo.InvariantCulture, storageKeyFormat, Guid.NewGuid().ToString("N"));
        factory.SeedS3Object(storageKey, 1024);

        var request = new ConfirmUploadRequestDto(
            UploadToken: Guid.NewGuid().ToString("N"),
            Title: titleLength > 0 ? new string('t', titleLength) : "Bypass Attempt",
            Files: new List<ConfirmedFileItemDto> { new(storageKey, fileName, "application/pdf", 1024) },
            ExpireInHours: expireInHours,
            MaxDownloads: maxDownloads,
            Password: password);

        var response = await _client.PostAsJsonAsync("/api/v1/files/confirm", request);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    #endregion

    #region 2. Happy Path Upload & Metadata Tests

    [Fact]
    public async Task GetPresignedUrl_Returns200OK_WhenPayloadIsValid()
    {
        var request = CreateValidPresignRequest();

        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await response.Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        result.Should().NotBeNull();
        result.UploadToken.Should().NotBeEmpty();
        result.Items.Should().HaveCount(1);
        result.Items[0].UploadUrl.Should().Contain("http://localhost:9000");
    }

    [Fact]
    public async Task ConfirmAndGetMetadataFlow_SuccessfullyStoresAndRetrievesBundle()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Test Report Bundle",
            [new("test_report.pdf", "application/pdf", 1024), new("test_chart.png", "image/png", 512)],
            maxDownloads: 10);

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();
        shareToken.Should().NotBeNullOrWhiteSpace();

        var metadataResponse = await _client.GetAsync($"/api/v1/files/{shareToken}");
        metadataResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var metadata = await metadataResponse.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        metadata.Should().NotBeNull();
        metadata!.Title.Should().Be("Test Report Bundle");
        metadata.FileCount.Should().Be(2);
        metadata.TotalSizeBytes.Should().Be(1536);
        metadata.RequiresPassword.Should().BeFalse();
        metadata.RemainingDownloads.Should().Be(10);
        metadata.IsExpired.Should().BeFalse();
    }

    #endregion

    #region 3. Authentication & Download Tests

    [Fact]
    public async Task GetGroupMetadata_MasksFilesAndSizes_WhenBundleIsPasswordProtected()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Classified Deliverables",
            [new("secret_financials.pdf", "application/pdf", 1024)],
            maxDownloads: 5,
            password: "VaultPassword123!");

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var response = await _client.GetAsync($"/api/v1/files/{shareToken}");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var metadata = await response.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        metadata.Should().NotBeNull();
        metadata!.RequiresPassword.Should().BeTrue();
        metadata.IsUnlocked.Should().BeFalse();
        metadata.Files.Should().BeEmpty();
        metadata.TotalSizeBytes.Should().Be(0);
    }

    [Fact]
    public async Task UnlockGroup_ReturnsFullMetadata_WhenPasswordIsCorrect()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Confidential Project",
            [new("client_contract.pdf", "application/pdf", 1024)],
            maxDownloads: 5,
            password: "CorrectVaultPassword!");

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var failedUnlockResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("WrongPassword!")
        );
        failedUnlockResponse.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var successUnlockResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("CorrectVaultPassword!")
        );

        successUnlockResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var unlockedMetadata = await successUnlockResponse.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        unlockedMetadata.Should().NotBeNull();
        unlockedMetadata!.IsUnlocked.Should().BeTrue();
        unlockedMetadata.Files.Should().HaveCount(1);
        unlockedMetadata.Files[0].FileName.Should().Be("client_contract.pdf");
        unlockedMetadata.TotalSizeBytes.Should().Be(1024);
    }

    [Fact]
    public async Task OpenDownloadSession_Returns401Unauthorized_WhenPasswordIsIncorrect()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Protected Bundle",
            [new("protected.pdf", "application/pdf", 1024)],
            maxDownloads: 5,
            password: "CorrectPassword123!");

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var sessionResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/downloads",
            new DownloadRequestDto("WrongPassword!")
        );

        sessionResponse.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await GetDownloadCountAsync(shareToken!)).Should().Be(0, "a rejected password must not consume a download");
    }

    [Fact]
    public async Task DownloadFile_Returns200OKWithPresignedUrl_WhenSessionIsOpenedWithCorrectPassword()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Protected Bundle 2",
            [new("protected_2.pdf", "application/pdf", 1024)],
            maxDownloads: 5,
            password: "CorrectPassword123!");

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var unlockResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("CorrectPassword123!")
        );
        var metadata = await unlockResponse.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        var fileId = metadata!.Files[0].Id;

        var sessionId = await OpenSessionIdAsync(shareToken!, "CorrectPassword123!");

        var downloadResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download/{fileId}",
            new DownloadRequestDto(null, sessionId)
        );

        downloadResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var downloadResult = await downloadResponse.Content.ReadFromJsonAsync<DownloadUrlResponseDto>();
        downloadResult.Should().NotBeNull();
        downloadResult!.DownloadUrl.Should().Contain("http://localhost:9000");
    }

    [Fact]
    public async Task ConfirmAndGetMetadata_ZeroKnowledgeEnvelopeFlow_StoresEnvelopeAndReturnsMaskedSalt()
    {
        var presigned = await PresignAndUploadAsync(
            "E2EE Envelope Vault",
            [new("mock_id.enc", "application/octet-stream", 1024)],
            maxDownloads: 5,
            password: "k_auth_derived_token_123",
            isEncrypted: true);
        var confirmRequest = presigned with
        {
            EncryptedManifest = "encrypted_manifest_base64",
            KeyEnvelope = "key_envelope_base64",
            KeySalt = "salt_base64"
        };

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();
        shareToken.Should().NotBeNullOrWhiteSpace();

        // 1. Initial GET when locked: returns KeySalt, but masks KeyEnvelope and EncryptedManifest
        var getResponse = await _client.GetAsync($"/api/v1/files/{shareToken}");
        getResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var metadata = await getResponse.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();

        metadata.Should().NotBeNull();
        metadata!.IsEncrypted.Should().BeTrue();
        metadata.RequiresPassword.Should().BeTrue();
        metadata.IsUnlocked.Should().BeFalse();
        metadata.KeySalt.Should().Be("salt_base64");
        metadata.KeyEnvelope.Should().BeNull();
        metadata.EncryptedManifest.Should().BeNull();
        metadata.Files.Should().BeEmpty();

        // 2. Unlock with invalid kAuth returns 401
        var failedUnlock = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("wrong_k_auth"));
        failedUnlock.StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        // 3. Unlock with valid kAuth returns unmasked metadata with KeyEnvelope and EncryptedManifest
        var successUnlock = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("k_auth_derived_token_123"));
        successUnlock.StatusCode.Should().Be(HttpStatusCode.OK);

        var unlockedMetadata = await successUnlock.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        unlockedMetadata.Should().NotBeNull();
        unlockedMetadata!.IsUnlocked.Should().BeTrue();
        unlockedMetadata.KeyEnvelope.Should().Be("key_envelope_base64");
        unlockedMetadata.KeySalt.Should().Be("salt_base64");
        unlockedMetadata.EncryptedManifest.Should().Be("encrypted_manifest_base64");
        unlockedMetadata.Files.Should().HaveCount(1);
    }
    
    #endregion
    
    #region 4. Real-Time Streaming ZIP Archive Tests

    [Fact]
    public async Task StreamBundleZip_Returns200AndValidZipArchive_WhenRequestIsValid()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Streaming Zip Bundle",
            [new("report.pdf", "application/pdf", 1024), new("chart.png", "image/png", 512)],
            maxDownloads: 5);

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var response =
            await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all", new DownloadRequestDto(null));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/zip");

        var zipBytes = await response.Content.ReadAsByteArrayAsync();
        using var ms = new MemoryStream(zipBytes);
        await using var archive = new ZipArchive(ms, ZipArchiveMode.Read);

        archive.Entries.Should().HaveCount(2);
        archive.Entries.Select(e => e.Name).Should().Contain(["report.pdf", "chart.png"]);
    }

    [Fact]
    public async Task StreamBundleZip_EnforcesDownloadCapacity_AndRejectsExcessClientsWithHardRejection()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Download Capacity Bundle",
            [new("capacity_doc.pdf", "application/pdf", 1024)],
            maxDownloads: 1);

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var responseClient1 = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download-all",
            new DownloadRequestDto(null));

        responseClient1.StatusCode.Should().Be(HttpStatusCode.OK);

        var responseClient2 = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download-all",
            new DownloadRequestDto(null));

        responseClient2.StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task StreamBundleZip_UnderConcurrentContention_EnforcesStrictAtomicDownloadLimit()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Race Condition Bundle",
            [new("race_file.txt", "text/plain", 2048)],
            maxDownloads: 1);

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();
        shareToken.Should().NotBeNullOrWhiteSpace();

        var tasks = Enumerable.Range(0, 10)
            .Select(_ => _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all", new DownloadRequestDto(null)))
            .ToArray();

        var responses = await Task.WhenAll(tasks);

        var successResponses = responses.Where(r => r.StatusCode == HttpStatusCode.OK).ToList();
        var goneResponses = responses.Where(r => r.StatusCode == HttpStatusCode.Gone).ToList();

        successResponses.Should().HaveCount(1);
        goneResponses.Should().HaveCount(9);

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var group = await dbContext.FileGroups
            .FirstOrDefaultAsync(g => g.ShareToken == shareToken);

        group.Should().NotBeNull();
        group!.DownloadCount.Should().Be(1);
    }

    [Fact]
    public async Task StreamBundleZip_Returns401Unauthorized_WhenPasswordIsIncorrect()
    {
        var confirmRequest = await PresignAndUploadAsync(
            "Protected Zip Bundle",
            [new("secret.pdf", "application/pdf", 1024)],
            maxDownloads: 5,
            password: "CorrectZipPassword1!");

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var response = await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all",
            new DownloadRequestDto("WrongPassword2@"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    #endregion
    
    #region 4b. Per-Bundle Download Session Tests

    [Fact]
    public async Task OpenDownloadSession_LastsSixHours_SoLongDownloadsAndRetriesDontCountAgain()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5);

        var session = (await (await OpenSessionAsync(shareToken)).Content.ReadFromJsonAsync<DownloadSessionResponseDto>())!;

        session.ExpiresAt.Should().BeCloseTo(DateTime.UtcNow + DownloadTimings.SessionLifetime, TimeSpan.FromMinutes(1));
        DownloadTimings.SessionLifetime.Should().Be(TimeSpan.FromHours(6));
    }

    [Fact]
    public async Task OpenDownloadSession_NeverOutlivesTheBundlesExpiry()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5);
        var bundleExpiresAt = DateTime.UtcNow.AddHours(1);
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.FileGroups
                .Where(g => g.ShareToken == shareToken)
                .ExecuteUpdateAsync(s => s.SetProperty(g => g.ExpiresAt, bundleExpiresAt));
        }

        var session = (await (await OpenSessionAsync(shareToken)).Content.ReadFromJsonAsync<DownloadSessionResponseDto>())!;

        session.ExpiresAt.Should().BeCloseTo(bundleExpiresAt, TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task DownloadSession_FetchesEveryFileOfBundle_AndCountsAsOneDownload()
    {
        var (shareToken, fileIds) = await CreateBundleAsync(fileCount: 3, maxDownloads: 1);

        var sessionResponse = await OpenSessionAsync(shareToken);
        sessionResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = await sessionResponse.Content.ReadFromJsonAsync<DownloadSessionResponseDto>();
        session!.RemainingDownloads.Should().Be(0);

        foreach (var fileId in fileIds)
        {
            var linkResponse = await RequestFileLinkAsync(shareToken, fileId, session.DownloadSessionId);
            linkResponse.StatusCode.Should().Be(HttpStatusCode.OK, "every file belongs to the same counted download");
        }

        (await GetDownloadCountAsync(shareToken)).Should().Be(1);

        // The bundle is used up for everyone else
        (await OpenSessionAsync(shareToken)).StatusCode.Should().Be(HttpStatusCode.Gone);
        (await _client.GetAsync($"/api/v1/files/{shareToken}")).StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task OpenDownloadSession_UnderConcurrentContention_AllowsExactlyMaxDownloads()
    {
        var (shareToken, _) = await CreateBundleAsync(fileCount: 2, maxDownloads: 2);

        var responses = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => OpenSessionAsync(shareToken)));

        responses.Count(r => r.StatusCode == HttpStatusCode.OK).Should().Be(2);
        responses.Count(r => r.StatusCode == HttpStatusCode.Gone).Should().Be(10);
        (await GetDownloadCountAsync(shareToken)).Should().Be(2);
    }

    [Fact]
    public async Task GenerateDownloadLink_Returns401_WhenSessionIsMissingUnknownOrFromAnotherBundle()
    {
        var (shareToken, fileIds) = await CreateBundleAsync(fileCount: 1, maxDownloads: 5);
        var (otherShareToken, _) = await CreateBundleAsync(fileCount: 1, maxDownloads: 5);
        var otherSessionId = await OpenSessionIdAsync(otherShareToken);

        (await RequestFileLinkAsync(shareToken, fileIds[0], null)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await RequestFileLinkAsync(shareToken, fileIds[0], Guid.NewGuid())).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await RequestFileLinkAsync(shareToken, fileIds[0], otherSessionId)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        (await GetDownloadCountAsync(shareToken)).Should().Be(0);
    }

    [Fact]
    public async Task GenerateDownloadLink_Returns401_WhenSessionHasExpired()
    {
        var (shareToken, fileIds) = await CreateBundleAsync(fileCount: 1, maxDownloads: 5);
        var sessionId = await OpenSessionIdAsync(shareToken);

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.DownloadSessions
                .Where(s => s.Id == sessionId)
                .ExecuteUpdateAsync(s => s.SetProperty(x => x.ExpiresAt, DateTime.UtcNow.AddMinutes(-1)));
        }

        (await RequestFileLinkAsync(shareToken, fileIds[0], sessionId)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task StreamBundleZip_WithExistingSession_DoesNotConsumeAnotherDownload()
    {
        var (shareToken, fileIds) = await CreateBundleAsync(fileCount: 2, maxDownloads: 1);
        var sessionId = await OpenSessionIdAsync(shareToken);

        (await RequestFileLinkAsync(shareToken, fileIds[0], sessionId)).StatusCode.Should().Be(HttpStatusCode.OK);

        var zipResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download-all",
            new DownloadRequestDto(null, sessionId));

        zipResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var zipBytes = await zipResponse.Content.ReadAsByteArrayAsync();
        using var ms = new MemoryStream(zipBytes);
        await using var archive = new ZipArchive(ms, ZipArchiveMode.Read);
        archive.Entries.Should().HaveCount(2);

        (await GetDownloadCountAsync(shareToken)).Should().Be(1);
    }

    [Fact]
    public async Task OpenDownloadSession_WithCorrectPassword_ConsumesExactlyOneDownload()
    {
        var (shareToken, _) = await CreateBundleAsync(fileCount: 1, maxDownloads: 3, password: "SessionPass123!");

        (await OpenSessionAsync(shareToken, "WrongPass123!")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await OpenSessionAsync(shareToken)).StatusCode.Should().Be(HttpStatusCode.Unauthorized);

        var response = await OpenSessionAsync(shareToken, "SessionPass123!");
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var session = await response.Content.ReadFromJsonAsync<DownloadSessionResponseDto>();
        session!.RemainingDownloads.Should().Be(2);

        (await GetDownloadCountAsync(shareToken)).Should().Be(1);
    }

    #endregion

    #region 5. Expiration & Not Found Tests

    [Fact]
    public async Task GetGroupMetadata_Returns404NotFound_WhenTokenDoesNotExist()
    {
        var response = await _client.GetAsync("/api/v1/files/non_existent_token_999");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task UnlockGroup_Returns404NotFound_WhenTokenDoesNotExist()
    {
        var response = await _client.PostAsJsonAsync(
            "/api/v1/files/non_existent_token_999/unlock",
            new DownloadRequestDto("AnyPassword123!"));

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Theory]
    [InlineData("UnlockPass123!")]
    [InlineData("WrongPass123!")]
    public async Task UnlockGroup_Returns410Gone_WhenBundleIsUsedUp(string attemptedPassword)
    {
        var (shareToken, _) = await CreateBundleAsync(fileCount: 1, maxDownloads: 1, password: "UnlockPass123!");
        await OpenSessionIdAsync(shareToken, "UnlockPass123!");

        var response = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto(attemptedPassword));

        response.StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task UnlockGroup_Returns410Gone_WhenBundleHasPassedItsExpiry()
    {
        var (shareToken, _) = await CreateBundleAsync(fileCount: 1, maxDownloads: 5, password: "ExpiredPass123!");

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.FileGroups
                .Where(g => g.ShareToken == shareToken)
                .ExecuteUpdateAsync(s => s.SetProperty(g => g.ExpiresAt, DateTime.UtcNow.AddMinutes(-1)));
        }

        var response = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("ExpiredPass123!"));

        response.StatusCode.Should().Be(HttpStatusCode.Gone, "an expired bundle must not be reported as a wrong password");
    }

    #endregion

    #region 6. Direct-to-S3 Presigned Multipart Tests

    [Fact]
    public async Task GetPresignedUrl_WhenFileExceeds50MB_InitiatesMultipartAndPresignsPartBatch()
    {
        long fileSize120Mb = 120L * 1024 * 1024; // 125,829,120 bytes

        var request = new CreatePresignedUrlRequestDto(
            Title: "Large Video Asset",
            Files: new List<FileItemInputDto>
            {
                new("raw_footage.mp4", "video/mp4", fileSize120Mb)
            },
            ExpireInHours: 24,
            MaxDownloads: 10,
            Password: null,
            IsEncrypted: false
        );

        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var result = await response.Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        result.Should().NotBeNull();
        result!.UploadToken.Should().NotBeNullOrWhiteSpace();
        result.Items.Should().HaveCount(1);

        var item = result.Items[0];
        item.UploadMode.Should().Be(UploadMode.Multipart);
        item.TotalParts.Should().Be(8);
        item.PartSizeBytes.Should().Be(16_777_216L); // 16 MB
        item.UploadId.Should().NotBeNullOrWhiteSpace();
        item.UploadUrl.Should().BeNull();

        // Presign batch 1..4
        var batchRequest = new PresignPartBatchRequestDto(
            UploadToken: result.UploadToken,
            StorageKey: item.StorageKey,
            UploadId: item.UploadId!,
            StartPartNumber: 1,
            Count: 4
        );

        var batchResponse = await _client.PostAsJsonAsync("/api/v1/files/multipart/presign-batch", batchRequest);
        batchResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var batchResult = await batchResponse.Content.ReadFromJsonAsync<PresignPartBatchResponseDto>();
        batchResult.Should().NotBeNull();
        batchResult!.Parts.Should().HaveCount(4);
        batchResult.Parts[0].PartNumber.Should().Be(1);
        batchResult.Parts[0].UploadUrl.Should().Contain("partNumber=1");
        batchResult.Parts[3].PartNumber.Should().Be(4);
    }

    [Fact]
    public async Task CompleteMultipartUpload_WithValidParts_MarksSessionCompletedAndAllowsConfirm()
    {
        long fileSize120Mb = 120L * 1024 * 1024;

        var presignRequest = new CreatePresignedUrlRequestDto(
            Title: "Archive File",
            Files: new List<FileItemInputDto>
            {
                new("archive.tar", "application/x-tar", fileSize120Mb)
            },
            ExpireInHours: 24,
            MaxDownloads: 10,
            Password: null,
            IsEncrypted: false
        );

        var presignResponse = await _client.PostAsJsonAsync("/api/v1/files/presign", presignRequest);
        var presignResult = await presignResponse.Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        var item = presignResult!.Items[0];

        // Seed object size in S3 mock so ConfirmUpload validation succeeds
        factory.SeedS3Object(item.StorageKey, fileSize120Mb);

        var parts = Enumerable.Range(1, 8)
            .Select(i => new CompletedPartInputDto(i, $"\"mock_etag_{i}\""))
            .ToList();

        var completeRequest = new CompleteMultipartUploadRequestDto(
            UploadToken: presignResult.UploadToken,
            StorageKey: item.StorageKey,
            UploadId: item.UploadId!,
            Parts: parts
        );

        var completeResponse = await _client.PostAsJsonAsync("/api/v1/files/multipart/complete", completeRequest);
        completeResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        // Verify in DB that session is marked Completed
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            var session = await dbContext.MultipartUploadSessions.FirstOrDefaultAsync(s => s.UploadId == item.UploadId);
            session.Should().NotBeNull();
            session!.IsCompleted.Should().BeTrue();
        }

        // Complete the bundle via /confirm
        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: presignResult.UploadToken,
            Title: "Archive File",
            Files: new List<ConfirmedFileItemDto>
            {
                new(item.StorageKey, "archive.tar", "application/x-tar", fileSize120Mb)
            },
            ExpireInHours: 24,
            MaxDownloads: 10,
            Password: null
        );

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        confirmResponse.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task GetPresignedUrl_WithSeveralFilesOver50MB_StartsOneMultipartUploadPerFile()
    {
        long fileSize120Mb = 120L * 1024 * 1024;

        var request = new CreatePresignedUrlRequestDto(
            Title: "Two Large Videos",
            Files: new List<FileItemInputDto>
            {
                new("take_1.mp4", "video/mp4", fileSize120Mb),
                new("take_2.mp4", "video/mp4", fileSize120Mb)
            },
            ExpireInHours: 24,
            MaxDownloads: 10,
            Password: null);

        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);
        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var result = await response.Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        result!.Items.Should().HaveCount(2);
        result.Items.Should().OnlyContain(i => i.UploadMode == UploadMode.Multipart);
        result.Items.Select(i => i.UploadId).Should().OnlyHaveUniqueItems();

        // Each file's session must be addressable on its own under the shared upload token.
        foreach (var item in result.Items)
        {
            var batchResponse = await _client.PostAsJsonAsync("/api/v1/files/multipart/presign-batch",
                new PresignPartBatchRequestDto(result.UploadToken, item.StorageKey, item.UploadId!, 1, 2));
            batchResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        }
    }

    [Theory]
    [InlineData(-2_000_000_000, 50)]
    [InlineData(0, 50)]
    [InlineData(1, 0)]
    [InlineData(1, -1)]
    [InlineData(1, int.MaxValue)]
    [InlineData(int.MaxValue, 50)]
    // past the end of this 8-part upload
    [InlineData(9, 1)]
    public async Task PresignPartBatch_Returns400BadRequest_WhenPartRangeIsInvalid(int startPartNumber, int count)
    {
        var presignResponse = await _client.PostAsJsonAsync("/api/v1/files/presign", new CreatePresignedUrlRequestDto(
            Title: "Range Check",
            Files: new List<FileItemInputDto> { new("clip.mp4", "video/mp4", 120L * 1024 * 1024) },
            ExpireInHours: 24,
            MaxDownloads: 10,
            Password: null));
        var presign = await presignResponse.Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        var item = presign!.Items[0];

        var response = await _client.PostAsJsonAsync("/api/v1/files/multipart/presign-batch",
            new PresignPartBatchRequestDto(presign.UploadToken, item.StorageKey, item.UploadId!, startPartNumber, count));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    #endregion

    #region 7. Presign-Bound Confirm Tests

    private Task<HttpResponseMessage> ConfirmAsync(ConfirmUploadRequestDto request) =>
        _client.PostAsJsonAsync("/api/v1/files/confirm", request);

    [Fact]
    public async Task ConfirmUpload_Returns404_WhenUploadTokenWasNeverPresigned()
    {
        var storageKey = $"uploads/{Guid.NewGuid():N}_unclaimed.pdf";
        factory.SeedS3Object(storageKey, 1024);

        var response = await ConfirmAsync(new ConfirmUploadRequestDto(
            UploadToken: Guid.NewGuid().ToString("N"),
            Title: "Never Presigned",
            Files: [new(storageKey, "unclaimed.pdf", "application/pdf", 1024)],
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: null));

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ConfirmUpload_IsSingleUse()
    {
        var request = await PresignAndUploadAsync("Single Use", [new("once.pdf", "application/pdf", 1024)], maxDownloads: 5);

        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ConfirmUpload_UnderConcurrentContention_CreatesExactlyOneBundle()
    {
        var request = await PresignAndUploadAsync("Raced Confirm", [new("raced.pdf", "application/pdf", 1024)], maxDownloads: 5);
        factory.MockS3Client.ClearReceivedCalls();

        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => ConfirmAsync(request)));

        responses.Count(r => r.StatusCode == HttpStatusCode.OK).Should().Be(1);
        responses.Where(r => r.StatusCode != HttpStatusCode.OK)
            .Should().OnlyContain(r => r.StatusCode == HttpStatusCode.NotFound || r.StatusCode == HttpStatusCode.BadRequest);

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var servedKeys = await dbContext.SharedFiles
            .Where(f => f.FileGroup.Title == "Raced Confirm")
            .Select(f => f.StorageKey)
            .ToListAsync();
        servedKeys.Should().ContainSingle();

        // Losing confirms remove only their own copies, never the one the winning bundle serves.
        DeletedKeys().Should().NotContain(servedKeys[0]);
    }

    [Fact]
    public async Task ConfirmUpload_Returns400_WhenFileSetDiffersFromPresign()
    {
        var request = await PresignAndUploadAsync(
            "Two Files",
            [new("a.pdf", "application/pdf", 1024), new("b.pdf", "application/pdf", 1024)],
            maxDownloads: 5);
        var otherRequest = await PresignAndUploadAsync("Other Upload", [new("c.pdf", "application/pdf", 1024)], maxDownloads: 5);

        // a file left out
        (await ConfirmAsync(request with { Files = [request.Files[0]] }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // another upload's file swapped in
        (await ConfirmAsync(request with { Files = [request.Files[0], otherRequest.Files[0]] }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // a file listed twice
        (await ConfirmAsync(request with { Files = [request.Files[0], request.Files[0], request.Files[1]] }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // rejections must not consume the upload
        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ConfirmUpload_Returns400_WhenFileDetailsDifferFromPresign()
    {
        var request = await PresignAndUploadAsync("Details", [new("report.pdf", "application/pdf", 1024)], maxDownloads: 5);
        var file = request.Files[0];

        (await ConfirmAsync(request with { Files = [file with { FileName = "renamed.pdf" }] }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(request with { Files = [file with { ContentType = "text/html" }] }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(request with { Files = [file with { SizeBytes = 512 }] }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(request with { IsEncrypted = true }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ConfirmUpload_Returns400_WhenStoredObjectIsLargerThanPresigned()
    {
        var request = await PresignAndUploadAsync("Oversized", [new("small.pdf", "application/pdf", 1024)], maxDownloads: 5);

        // The presigned PUT doesn't cap size, so the client uploaded far more than it declared.
        factory.SeedS3Object(request.Files[0].StorageKey, 10L * 1024 * 1024 * 1024);

        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ConfirmUpload_Returns404_WhenPendingUploadHasExpired()
    {
        var request = await PresignAndUploadAsync("Late Confirm", [new("late.pdf", "application/pdf", 1024)], maxDownloads: 5);

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.PendingUploads
                .Where(p => p.UploadToken == request.UploadToken)
                .ExecuteUpdateAsync(s => s.SetProperty(p => p.ExpiresAt, DateTime.UtcNow.AddMinutes(-1)));
        }

        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task PresignAndConfirm_Return400_WhenExpiryIsMissing()
    {
        (await _client.PostAsJsonAsync("/api/v1/files/presign", CreateValidPresignRequest() with { ExpireInHours = null }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var request = await PresignAndUploadAsync("No Expiry", [new("forever.pdf", "application/pdf", 1024)], maxDownloads: null);
        (await ConfirmAsync(request with { ExpireInHours = null }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // An expiry alone is enough: unlimited downloads stay allowed.
        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ConfirmUpload_Returns400_WhenKeyMaterialIsOversized()
    {
        var request = await PresignAndUploadAsync(
            "Oversized Keys",
            [new("blob.enc", "application/octet-stream", 1024)],
            maxDownloads: 5,
            password: "k_auth_derived_token_123",
            isEncrypted: true);
        var valid = request with
        {
            EncryptedManifest = new string('m', 1000),
            KeyEnvelope = new string('e', 80),
            KeySalt = new string('s', 22)
        };

        // An oversized salt used to reach the varchar(64) column and fail as a 500.
        (await ConfirmAsync(valid with { KeySalt = new string('s', 65) }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(valid with { KeyEnvelope = new string('e', 129) }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(valid with { EncryptedManifest = new string('m', 256 * 1024 + 1) }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Realistic sizes still confirm.
        (await ConfirmAsync(valid)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task ConfirmUpload_Returns400_WhenUnencryptedUploadCarriesKeyMaterial()
    {
        var request = await PresignAndUploadAsync("Plain With Keys", [new("plain.pdf", "application/pdf", 1024)], maxDownloads: 5);

        (await ConfirmAsync(request with { EncryptedManifest = "smuggled" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(request with { KeyEnvelope = "smuggled" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ConfirmAsync(request with { KeySalt = "smuggled" }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("evil.exe ")]
    [InlineData("evil.e x e")]
    public async Task GetPresignedUrl_Returns400_WhenNameSanitizesToAForbiddenExtension(string fileName)
    {
        var request = CreateValidPresignRequest() with
        {
            Files = [new FileItemInputDto(fileName, "application/octet-stream", 1024)]
        };

        (await _client.PostAsJsonAsync("/api/v1/files/presign", request))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    #endregion

    #region 8. Non-ASCII Names & Error Responses

    [Fact]
    public async Task StreamBundleZip_WithPolishTitle_ReturnsZip_WithEncodedFileName()
    {
        var request = await PresignAndUploadAsync(
            "Zdjęcia z wakacji",
            [new("zażółć.txt", "text/plain", 1024)],
            maxDownloads: 5);
        var shareToken = await (await ConfirmAsync(request)).Content.ReadFromJsonAsync<string>();

        var response = await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all", new DownloadRequestDto(null));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var disposition = string.Join(",", response.Content.Headers.GetValues("Content-Disposition"));
        disposition.Should().Contain($"filename=\"Zdjecia_z_wakacji_{shareToken}.zip\"");
        disposition.Should().Contain($"filename*=UTF-8''Zdj%C4%99cia_z_wakacji_{shareToken}.zip");

        await using var archive = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()), ZipArchiveMode.Read);
        archive.Entries.Select(e => e.Name).Should().ContainSingle().Which.Should().Be("zażółć.txt");
    }

    [Fact]
    public async Task GenerateDownloadLink_WithPolishFileName_AsksStorageForAnAsciiContentDisposition()
    {
        var request = await PresignAndUploadAsync("Polish File", [new("zażółć.txt", "text/plain", 1024)], maxDownloads: 5);
        var shareToken = (await (await ConfirmAsync(request)).Content.ReadFromJsonAsync<string>())!;
        var metadata = await _client.GetFromJsonAsync<FileGroupMetadataResponseDto>($"/api/v1/files/{shareToken}");
        var sessionId = await OpenSessionIdAsync(shareToken);
        factory.MockS3Client.ClearReceivedCalls();

        (await RequestFileLinkAsync(shareToken, metadata!.Files[0].Id, sessionId)).StatusCode.Should().Be(HttpStatusCode.OK);

        var presignRequest = factory.MockS3Client.ReceivedCalls()
            .Where(c => c.GetMethodInfo().Name == nameof(Amazon.S3.IAmazonS3.GetPreSignedURL))
            .Select(c => (GetPreSignedUrlRequest)c.GetArguments()[0]!)
            .Single(r => r.Verb == Amazon.S3.HttpVerb.GET);

        presignRequest.ResponseHeaderOverrides.ContentDisposition
            .Should().Be("attachment; filename=\"zazo_c.txt\"; filename*=UTF-8''za%C5%BC%C3%B3%C5%82%C4%87.txt");
    }

    [Fact]
    public async Task Presign_WithMalformedJson_Returns400ProblemDetails_NotA500()
    {
        var response = await _client.PostAsync("/api/v1/files/presign",
            new StringContent("{\"files\": [ not json", System.Text.Encoding.UTF8, "application/json"));

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        var problem = await response.Content.ReadFromJsonAsync<Microsoft.AspNetCore.Mvc.ProblemDetails>();
        problem!.Title.Should().Be("Bad Request");
    }

    #endregion

    #region 9. Per-Bundle Password Lockout Tests

    private const string LockoutPassword = "CorrectHorse1";

    private Task<HttpResponseMessage> UnlockAsync(string shareToken, string password) =>
        _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/unlock", new DownloadRequestDto(password));

    private async Task<(int FailedAttempts, DateTime? LockedUntil)> GetLockStateAsync(string shareToken)
    {
        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var group = await dbContext.FileGroups.AsNoTracking().FirstAsync(g => g.ShareToken == shareToken);
        return (group.FailedPasswordAttempts, group.PasswordLockedUntil);
    }

    [Fact]
    public async Task PasswordLockout_AfterFreeAttempts_RefusesEvenTheCorrectPassword()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5, password: LockoutPassword);

        // Five free wrong attempts, then the sixth sets the first lock; each still answers 401.
        for (int i = 0; i < 6; i++)
        {
            (await UnlockAsync(shareToken, "wrong-guess")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }

        var locked = await UnlockAsync(shareToken, LockoutPassword);

        locked.StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        var retryAfter = locked.Headers.RetryAfter!.Delta!.Value;
        retryAfter.Should().BeGreaterThan(TimeSpan.Zero).And.BeLessThanOrEqualTo(TimeSpan.FromMinutes(1));
        var problem = await locked.Content.ReadFromJsonAsync<Microsoft.AspNetCore.Mvc.ProblemDetails>();
        problem!.Title.Should().Be("Too Many Attempts");

        (await GetLockStateAsync(shareToken)).FailedAttempts.Should().Be(6, "a refused attempt is never verified, so it is not counted");
    }

    [Fact]
    public async Task PasswordLockout_IsSharedByUnlock_DownloadSession_AndZipEndpoints()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5, password: LockoutPassword);

        for (int i = 0; i < 2; i++)
        {
            (await UnlockAsync(shareToken, "wrong-guess")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            (await OpenSessionAsync(shareToken, "wrong-guess")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
            (await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all", new DownloadRequestDto("wrong-guess")))
                .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        }

        (await OpenSessionAsync(shareToken, LockoutPassword)).StatusCode.Should().Be(HttpStatusCode.TooManyRequests);
        (await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all", new DownloadRequestDto(LockoutPassword)))
            .StatusCode.Should().Be(HttpStatusCode.TooManyRequests);

        (await GetDownloadCountAsync(shareToken)).Should().Be(0);
    }

    [Fact]
    public async Task PasswordLockout_OnceExpired_AcceptsTheCorrectPassword_AndResetsTheCounter()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5, password: LockoutPassword);

        for (int i = 0; i < 6; i++)
        {
            await UnlockAsync(shareToken, "wrong-guess");
        }

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.FileGroups
                .Where(g => g.ShareToken == shareToken)
                .ExecuteUpdateAsync(s => s.SetProperty(g => g.PasswordLockedUntil, DateTime.UtcNow.AddSeconds(-1)));
        }

        (await UnlockAsync(shareToken, LockoutPassword)).StatusCode.Should().Be(HttpStatusCode.OK);

        var (failedAttempts, lockedUntil) = await GetLockStateAsync(shareToken);
        failedAttempts.Should().Be(0);
        lockedUntil.Should().BeNull();
    }

    [Fact]
    public async Task PasswordLockout_ParallelGuesses_OnlyTheFreeAttemptsAndOneMoreAreVerified()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5, password: LockoutPassword);

        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => UnlockAsync(shareToken, "wrong-guess")));

        // The five free attempts plus the one that sets the first lock are verified; the rest arrive while
        // that check holds the bundle, and must be refused rather than verified alongside it.
        responses.Count(r => r.StatusCode == HttpStatusCode.Unauthorized).Should().Be(PasswordLockoutFreeAttempts + 1);
        responses.Count(r => r.StatusCode == HttpStatusCode.TooManyRequests).Should().Be(20 - PasswordLockoutFreeAttempts - 1);

        var (failedAttempts, lockedUntil) = await GetLockStateAsync(shareToken);
        failedAttempts.Should().Be(PasswordLockoutFreeAttempts + 1);
        lockedUntil.Should().BeAfter(DateTime.UtcNow.AddSeconds(45), "the wrong guess replaced the short hold with the one-minute lock");
    }

    [Fact]
    public async Task PasswordLockout_ParallelGuessesWhenALockExpires_OnlyOneIsVerified()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5, password: LockoutPassword);

        for (int i = 0; i < 6; i++)
        {
            await UnlockAsync(shareToken, "wrong-guess");
        }

        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            await dbContext.FileGroups
                .Where(g => g.ShareToken == shareToken)
                .ExecuteUpdateAsync(s => s.SetProperty(g => g.PasswordLockedUntil, DateTime.UtcNow.AddSeconds(-1)));
        }

        var responses = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => UnlockAsync(shareToken, "wrong-guess")));

        responses.Count(r => r.StatusCode == HttpStatusCode.Unauthorized).Should().Be(1);
        responses.Count(r => r.StatusCode == HttpStatusCode.TooManyRequests).Should().Be(19);
        (await GetLockStateAsync(shareToken)).FailedAttempts.Should().Be(7);
    }

    private const int PasswordLockoutFreeAttempts = FileHolder.Core.Configuration.PasswordLockout.FreeAttempts;

    #endregion

    #region 9b. Bundle Metadata Lookup

    [Fact]
    public async Task GetGroupMetadata_ForAnUnknownToken_IsNotCached()
    {
        var shareToken = FileHolder.Core.Security.CryptoUtils.GenerateShortToken();

        (await _client.GetAsync($"/api/v1/files/{shareToken}")).StatusCode.Should().Be(HttpStatusCode.NotFound);

        // Had the miss been cached, a bundle that now holds the token would still answer 404.
        using (var scope = factory.Services.CreateScope())
        {
            var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            dbContext.FileGroups.Add(new FileGroup
            {
                ShareToken = shareToken,
                MaxDownloads = 1,
                ExpiresAt = DateTime.UtcNow.AddHours(1),
                Files = { new SharedFile { OriginalFileName = "late.pdf", StorageKey = "files/late", ContentType = "application/pdf", SizeBytes = 10 } }
            });
            await dbContext.SaveChangesAsync();
        }

        (await _client.GetAsync($"/api/v1/files/{shareToken}")).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public void GetGroupMetadata_IsRateLimited()
    {
        var endpoint = factory.Services.GetRequiredService<Microsoft.AspNetCore.Routing.EndpointDataSource>().Endpoints
            .Single(e => e.Metadata.GetMetadata<Microsoft.AspNetCore.Routing.IEndpointNameMetadata>()?.EndpointName == "GetGroupMetadata");

        endpoint.Metadata.GetMetadata<Microsoft.AspNetCore.RateLimiting.EnableRateLimitingAttribute>()?.PolicyName
            .Should().Be("MetadataPolicy");
    }

    #endregion

    #region 10. Confirm Serves a Copy of Single-PUT Files

    private async Task<SharedFile> GetOnlySharedFileAsync(string shareToken)
    {
        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await dbContext.SharedFiles.AsNoTracking().SingleAsync(f => f.FileGroup.ShareToken == shareToken);
    }

    private IEnumerable<string> DeletedKeys() => factory.MockS3Client.ReceivedCalls()
        .Where(c => c.GetMethodInfo().Name == nameof(Amazon.S3.IAmazonS3.DeleteObjectsAsync))
        .Select(c => (DeleteObjectsRequest)c.GetArguments()[0]!)
        .SelectMany(r => r.Objects.Select(o => o.Key));

    [Fact]
    public async Task ConfirmUpload_ServesSingleFilesFromACopy_AndLeavesTheOriginalToThePurge()
    {
        var request = await PresignAndUploadAsync("Copied", [new("copied.pdf", "application/pdf", 1024)], maxDownloads: 5);
        var uploadedKey = request.Files[0].StorageKey;

        var shareToken = (await (await ConfirmAsync(request)).Content.ReadFromJsonAsync<string>())!;

        var sharedFile = await GetOnlySharedFileAsync(shareToken);
        sharedFile.StorageKey.Should().StartWith("files/").And.NotBe(uploadedKey);
        factory.S3ObjectRegistry.Should().ContainKey(sharedFile.StorageKey);

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var purgeRow = await dbContext.PendingUploads.AsNoTracking().SingleAsync(p => p.StorageKey == uploadedKey);
        purgeRow.UploadToken.Should().NotBe(request.UploadToken, "no confirm may ever claim the purge row");
        purgeRow.ExpiresAt.Should().BeOnOrBefore(DateTime.UtcNow);
    }

    [Fact]
    public async Task ConfirmUpload_ThenOverwritingTheUpload_DoesNotChangeWhatIsServed()
    {
        var request = await PresignAndUploadAsync("Swap Attempt", [new("swap.pdf", "application/pdf", 1024)], maxDownloads: 5);
        var shareToken = (await (await ConfirmAsync(request)).Content.ReadFromJsonAsync<string>())!;
        var servedKey = (await GetOnlySharedFileAsync(shareToken)).StorageKey;

        // The uploader reuses the still-valid PUT URL.
        factory.SeedS3Object(request.Files[0].StorageKey, 999_999_999);

        var metadata = await _client.GetFromJsonAsync<FileGroupMetadataResponseDto>($"/api/v1/files/{shareToken}");
        var sessionId = await OpenSessionIdAsync(shareToken);
        factory.MockS3Client.ClearReceivedCalls();

        (await RequestFileLinkAsync(shareToken, metadata!.Files[0].Id, sessionId)).StatusCode.Should().Be(HttpStatusCode.OK);

        var presignRequest = factory.MockS3Client.ReceivedCalls()
            .Where(c => c.GetMethodInfo().Name == nameof(Amazon.S3.IAmazonS3.GetPreSignedURL))
            .Select(c => (GetPreSignedUrlRequest)c.GetArguments()[0]!)
            .Single(r => r.Verb == Amazon.S3.HttpVerb.GET);
        presignRequest.Key.Should().Be(servedKey);
        factory.S3ObjectRegistry[servedKey].Should().Be(1024);
    }

    [Fact]
    public async Task ConfirmUpload_Returns400_AndRemovesTheCopy_WhenTheCopyHasTheWrongSize()
    {
        var request = await PresignAndUploadAsync("Grows", [new("grows_during_copy.pdf", "application/pdf", 1024)], maxDownloads: 5);
        factory.MockS3Client.ClearReceivedCalls();

        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var copiedKey = factory.MockS3Client.ReceivedCalls()
            .Where(c => c.GetMethodInfo().Name == nameof(Amazon.S3.IAmazonS3.CopyObjectAsync))
            .Select(c => ((CopyObjectRequest)c.GetArguments()[0]!).DestinationKey)
            .Single();
        DeletedKeys().Should().Contain(copiedKey);
    }

    [Fact]
    public async Task ConfirmUpload_DoesNotCopyMultipartFiles()
    {
        const long size120Mb = 120L * 1024 * 1024;
        var request = await PresignAndUploadAsync("Big", [new("big.tar", "application/x-tar", size120Mb)], maxDownloads: 5);
        factory.MockS3Client.ClearReceivedCalls();

        var shareToken = (await (await ConfirmAsync(request)).Content.ReadFromJsonAsync<string>())!;

        (await GetOnlySharedFileAsync(shareToken)).StorageKey.Should().Be(request.Files[0].StorageKey);
        factory.MockS3Client.ReceivedCalls()
            .Should().NotContain(c => c.GetMethodInfo().Name == nameof(Amazon.S3.IAmazonS3.CopyObjectAsync));

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        (await dbContext.PendingUploads.AnyAsync(p => p.StorageKey == request.Files[0].StorageKey))
            .Should().BeFalse("the purge must never delete a multipart file a bundle serves");
    }

    [Fact]
    public async Task Purge_DeletesTheConfirmedOriginal_OnceItsGraceHasPassed()
    {
        var request = await PresignAndUploadAsync("Purged Original", [new("original.pdf", "application/pdf", 1024)], maxDownloads: 5);
        var uploadedKey = request.Files[0].StorageKey;
        (await ConfirmAsync(request)).StatusCode.Should().Be(HttpStatusCode.OK);

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        await dbContext.PendingUploads
            .Where(p => p.StorageKey == uploadedKey)
            .ExecuteUpdateAsync(s => s.SetProperty(p => p.ExpiresAt, DateTime.UtcNow.AddHours(-2)));
        factory.MockS3Client.ClearReceivedCalls();

        await scope.ServiceProvider.GetRequiredService<IStoragePurgeService>().PurgeExpiredFilesAsync();

        DeletedKeys().Should().Contain(uploadedKey);
        (await dbContext.PendingUploads.AnyAsync(p => p.StorageKey == uploadedKey)).Should().BeFalse();
    }

    #endregion

    #region 11. Upload Limits, Signed Sizes & Bundle ZIP Names

    private const long OneGb = 1024L * 1024 * 1024;

    private Task<HttpResponseMessage> PresignAsync(List<FileItemInputDto> files, bool isEncrypted = false) =>
        _client.PostAsJsonAsync("/api/v1/files/presign",
            new CreatePresignedUrlRequestDto("Limits", files, 24, 5, isEncrypted ? "EncryptedPass1" : null, isEncrypted));

    private List<GetPreSignedUrlRequest> UploadPresignRequests() => factory.MockS3Client.ReceivedCalls()
        .Where(c => c.GetMethodInfo().Name == nameof(Amazon.S3.IAmazonS3.GetPreSignedURL))
        .Select(c => (GetPreSignedUrlRequest)c.GetArguments()[0]!)
        .Where(r => r.Verb == Amazon.S3.HttpVerb.PUT)
        .ToList();

    [Fact]
    public async Task Presign_SignsSingleUploadUrlsForTheDeclaredSize()
    {
        factory.MockS3Client.ClearReceivedCalls();

        (await PresignAsync([new("small.pdf", "application/pdf", 12_345)])).StatusCode.Should().Be(HttpStatusCode.OK);

        UploadPresignRequests().Single().Headers.ContentLength.Should().Be(12_345);
    }

    [Fact]
    public async Task PresignPartBatch_SignsEachPartForItsSize_AndTheLastForTheRemainder()
    {
        const long partSize = 16L * 1024 * 1024;
        const long totalSize = 120L * 1024 * 1024; // 7 full parts and an 8 MB remainder
        var presign = (await (await PresignAsync([new("clip.mp4", "video/mp4", totalSize)]))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!;
        var item = presign.Items[0];
        factory.MockS3Client.ClearReceivedCalls();

        (await _client.PostAsJsonAsync("/api/v1/files/multipart/presign-batch",
            new PresignPartBatchRequestDto(presign.UploadToken, item.StorageKey, item.UploadId!, 1, 8)))
            .StatusCode.Should().Be(HttpStatusCode.OK);

        var lengths = UploadPresignRequests().OrderBy(r => r.PartNumber).Select(r => r.Headers.ContentLength).ToList();
        lengths.Should().Equal(Enumerable.Repeat(partSize, 7).Append(totalSize - 7 * partSize));
    }

    [Fact]
    public async Task Presign_SizesEncryptedPartsAsWholeEncryptedChunks()
    {
        const long encryptedChunk = 4L * 1024 * 1024 + 16;
        const long size120Mb = 120L * 1024 * 1024;

        var plain = (await (await PresignAsync([new("clip.mp4", "video/mp4", size120Mb)]))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!.Items[0];
        var encrypted = (await (await PresignAsync([new("clip.enc", "application/octet-stream", size120Mb)], isEncrypted: true))
            .Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!.Items[0];

        plain.PartSizeBytes.Should().Be(16L * 1024 * 1024, "plain uploads keep the 16 MiB minimum part");
        encrypted.PartSizeBytes.Should().Be(4 * encryptedChunk, "the smallest whole number of encrypted chunks at or above 16 MiB");
        encrypted.TotalParts.Should().Be((int)Math.Ceiling((double)size120Mb / encrypted.PartSizeBytes!.Value));
    }

    [Fact]
    public async Task Presign_AcceptsABundleOfExactlyTheSizeLimit_SpreadOverFiles()
    {
        var files = Enumerable.Range(1, 5).Select(i => new FileItemInputDto($"part{i}.bin", "application/octet-stream", OneGb)).ToList();

        (await PresignAsync(files)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await PresignAsync([.. files, new("one-more.txt", "text/plain", 1)])).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Presign_RejectsDeclaredSizesThatWouldOverflowTheirSum_With400()
    {
        var files = new List<FileItemInputDto> { new("a.bin", "application/octet-stream", long.MaxValue), new("b.bin", "application/octet-stream", long.MaxValue) };

        (await PresignAsync(files)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Presign_AcceptsEncryptedFilesOver1Gb()
    {
        (await PresignAsync([new("a.enc", "application/octet-stream", EncryptedStreamFormat.EncryptedSize(2 * OneGb))], isEncrypted: true))
            .StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task Presign_LetsAnEncryptedBundleOfExactly5GbOfPlaintextThrough_ButNoMore()
    {
        // Five 1 GB files encrypt to 5 GB plus their tags, which the plain 5 GB limit alone would refuse.
        var fullBundle = Enumerable.Range(1, 5)
            .Select(i => new FileItemInputDto($"part{i}.enc", "application/octet-stream", EncryptedStreamFormat.EncryptedSize(OneGb)))
            .ToList();
        (await PresignAsync(fullBundle, isEncrypted: true)).StatusCode.Should().Be(HttpStatusCode.OK);

        // The bound itself, and one byte past it.
        long maxForOneFile = EncryptedStreamFormat.MaxEncryptedTotal(5 * OneGb, 1);
        (await PresignAsync([new("a.enc", "application/octet-stream", maxForOneFile)], isEncrypted: true))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await PresignAsync([new("a.enc", "application/octet-stream", maxForOneFile + 1)], isEncrypted: true))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task Presign_DoesNotGivePlainBundlesTheEncryptionAllowance()
    {
        (await PresignAsync([new("a.bin", "application/octet-stream", 5 * OneGb + 1)]))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData("text/plain; charset=utf-8")]
    [InlineData("application/vnd.openxmlformats-officedocument.wordprocessingml.document")]
    [InlineData("image/svg+xml")]
    public async Task Presign_AcceptsRealMediaTypes(string contentType)
    {
        (await PresignAsync([new("file.dat", contentType, 1024)])).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Fact]
    public async Task StreamBundleZip_GivesFilesWithTheSameNameDistinctEntries()
    {
        var request = await PresignAndUploadAsync("Same Names",
            [new("report.pdf", "application/pdf", 1024), new("Report.pdf", "application/pdf", 1024), new("report.pdf", "application/pdf", 1024)],
            maxDownloads: 5);
        var shareToken = (await (await ConfirmAsync(request)).Content.ReadFromJsonAsync<string>())!;

        var response = await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all", new DownloadRequestDto(null));

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        await using var archive = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()), ZipArchiveMode.Read);
        archive.Entries.Select(e => e.FullName.ToLowerInvariant()).Should().OnlyHaveUniqueItems();
        archive.Entries.Should().HaveCount(3);
    }

    [Fact]
    public async Task StreamBundleZipForSession_StreamsTheZip_WithoutCountingAnotherDownload()
    {
        var (shareToken, _) = await CreateBundleAsync(2, maxDownloads: 5);
        var sessionId = await OpenSessionIdAsync(shareToken);

        var response = await _client.GetAsync($"/api/v1/files/{shareToken}/download-all?downloadSessionId={sessionId}");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType!.MediaType.Should().Be("application/zip");
        response.Content.Headers.ContentDisposition!.DispositionType.Should().Be("attachment");
        await using var archive = new ZipArchive(new MemoryStream(await response.Content.ReadAsByteArrayAsync()), ZipArchiveMode.Read);
        archive.Entries.Should().HaveCount(2);
        (await GetDownloadCountAsync(shareToken)).Should().Be(1);
    }

    [Fact]
    public async Task StreamBundleZipForSession_RequiresAValidSession()
    {
        var (shareToken, _) = await CreateBundleAsync(1, maxDownloads: 5);

        (await _client.GetAsync($"/api/v1/files/{shareToken}/download-all")).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await _client.GetAsync($"/api/v1/files/{shareToken}/download-all?downloadSessionId={Guid.NewGuid()}"))
            .StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await GetDownloadCountAsync(shareToken)).Should().Be(0, "the GET never opens a session itself");
    }

    #endregion
}