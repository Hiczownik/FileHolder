using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using Amazon.S3.Model;
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
            new("architecture_diagram.pdf", "application.pdf", 1024)
        },
        ExpireInHours: 24,
        MaxDownloads: 10,
        Password: "ValidPassword123!"
    );

    #endregion

    #region 1. Validation Boundary Tests ([Theory] Data-Driven)

    [Theory]
    // forbidden extensions
    [InlineData("script.sh", "application/x-sh", 1024, 24, 10, null)]
    [InlineData("library.dll", "application/octet-stream", 1024, 24, 10, null)]
    // file size
    [InlineData("document.pdf", "application/pdf", 0, 24, 10, null)]
    // expiration limit
    [InlineData("document.pdf", "application/pdf", 1024, 0, 10, null)]
    [InlineData("document.pdf", "application/pdf", 1024, 200, 10, null)]
    // download limit
    [InlineData("document.pdf", "application/pdf", 1024, 24, 0, null)]
    [InlineData("document.pdf", "application/pdf", 1024, 24, 2000, null)]
    // password
    [InlineData("document.pdf", "application/pdf", 1024, 24, 10, "123")]
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
        factory.SeedS3Object("uploads/test_key_1.pdf", 1024);
        factory.SeedS3Object("uploads/test_key_2.png", 512);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "test_upload_token",
            Title: "Test Report Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/test_key_1.pdf", "test_report.pdf", "application/pdf", 1024),
                new("uploads/test_key_2.png", "test_chart.png", "image/png", 512)
            },
            ExpireInHours: 24,
            MaxDownloads: 10,
            Password: null
        );

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
        factory.SeedS3Object("uploads/masked_doc.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "masked_token",
            Title: "Classified Deliverables",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/masked_doc.pdf", "secret_financials.pdf", "application/pdf", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: "VaultPassword123!"
        );

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
        factory.SeedS3Object("uploads/unlock_doc.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "unlock_token",
            Title: "Confidential Project",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/unlock_doc.pdf", "client_contract.pdf", "application/pdf", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: "CorrectVaultPassword!"
        );

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
    public async Task DownloadFile_Returns401Unauthorized_WhenPasswordIsIncorrect()
    {
        factory.SeedS3Object("uploads/protected_key.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "protected_token",
            Title: "Protected Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/protected_key.pdf", "protected.pdf", "application/pdf", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: "CorrectPassword123!"
        );

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var unlockResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("CorrectPassword123!")
        );
        var metadata = await unlockResponse.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        var fileId = metadata!.Files[0].Id;

        var downloadResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download/{fileId}",
            new DownloadRequestDto("WrongPassword!")
        );

        downloadResponse.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Fact]
    public async Task DownloadFile_Returns200OKWithPresignedUrl_WhenPasswordIsCorrect()
    {
        factory.SeedS3Object("uploads/protected_key_2.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "protected_token_2",
            Title: "Protected Bundle 2",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/protected_key_2.pdf", "protected_2.pdf", "application/pdf", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: "CorrectPassword123!"
        );

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var unlockResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/unlock",
            new DownloadRequestDto("CorrectPassword123!")
        );
        var metadata = await unlockResponse.Content.ReadFromJsonAsync<FileGroupMetadataResponseDto>();
        var fileId = metadata!.Files[0].Id;

        var downloadResponse = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download/{fileId}",
            new DownloadRequestDto("CorrectPassword123!")
        );

        downloadResponse.StatusCode.Should().Be(HttpStatusCode.OK);
        var downloadResult = await downloadResponse.Content.ReadFromJsonAsync<DownloadUrlResponseDto>();
        downloadResult.Should().NotBeNull();
        downloadResult!.DownloadUrl.Should().Contain("http://localhost:9000");
    }

    [Fact]
    public async Task ConfirmAndGetMetadata_ZeroKnowledgeEnvelopeFlow_StoresEnvelopeAndReturnsMaskedSalt()
    {
        factory.SeedS3Object("uploads/e2ee_file.enc", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "e2ee_upload_token",
            Title: "E2EE Envelope Vault",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/e2ee_file.enc", "mock_id.enc", "application/octet-stream", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: "k_auth_derived_token_123",
            IsEncrypted: true,
            EncryptedManifest: "encrypted_manifest_base64",
            KeyEnvelope: "key_envelope_base64",
            KeySalt: "salt_base64"
        );

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
        factory.SeedS3Object("uploads/zip_file_1.pdf", 1024);
        factory.SeedS3Object("uploads/zip_file_2.png", 512);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "zip_test_token",
            Title: "Streaming Zip Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/zip_file_1.pdf", "report.pdf", "application/pdf", 1024),
                new("uploads/zip_file_2.png", "chart.png", "image/png", 512),
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: null
        );

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
        factory.SeedS3Object("uploads/capacity_doc.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "capacity_test_token",
            Title: "Download Capacity Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/capacity_doc.pdf", "capacity_doc.pdf", "application/pdf", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 1,
            Password: null
        );

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
        factory.SeedS3Object("uploads/race_file.txt", 2048);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "race_test_token",
            Title: "Race Condition Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/race_file.txt", "race_file.txt", "text/plain", 2048)
            },
            ExpireInHours: 24,
            MaxDownloads: 1,
            Password: null
        );

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
        factory.SeedS3Object("uploads/zip_protected.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "zip_protected_token",
            Title: "Protected Zip Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/zip_protected.pdf", "secret.pdf", "application/pdf", 1024)
            },
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: "CorrectZipPassword1!"
        );

        var confirmResponse = await _client.PostAsJsonAsync("/api/v1/files/confirm", confirmRequest);
        var shareToken = await confirmResponse.Content.ReadFromJsonAsync<string>();

        var response = await _client.PostAsJsonAsync($"/api/v1/files/{shareToken}/download-all",
            new DownloadRequestDto("WrongPassword2@"));

        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    #endregion
    
    #region 5. Expiration & Not Found Tests

    [Fact]
    public async Task GetGroupMetadata_Returns404NotFound_WhenTokenDoesNotExist()
    {
        var response = await _client.GetAsync("/api/v1/files/non_existent_token_999");

        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
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

    #endregion
}