using System.IO.Compression;
using System.Net;
using System.Net.Http.Json;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Infrastructure.Data;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

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
    public async Task StreamBundleZip_EnforcesLeaseCapacity_AndRejectsExcessClientsWithHardRejection()
    {
        factory.SeedS3Object("uploads/lease_doc.pdf", 1024);

        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "lease_test_token",
            Title: "Lease Capacity Bundle",
            Files: new List<ConfirmedFileItemDto>
            {
                new("uploads/lease_doc.pdf", "lease_doc.pdf", "application/pdf", 1024)
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
        var leaseToken = responseClient1.Headers.GetValues("X-Download-Lease").FirstOrDefault();
        leaseToken.Should().NotBeNullOrWhiteSpace();

        var responseClient2 = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download-all",
            new DownloadRequestDto(null));
        
        responseClient2.StatusCode.Should().Be(HttpStatusCode.Gone);
        
        var responseAfterExhaustion = await _client.PostAsJsonAsync(
            $"/api/v1/files/{shareToken}/download-all?lease={leaseToken}",
            new DownloadRequestDto(null));
        
        responseAfterExhaustion.StatusCode.Should().Be(HttpStatusCode.Gone);
    }

    [Fact]
    public async Task StreamBundleZip_UnderConcurrentContention_EnforcesStrictAtomicLeaseLimit()
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

        var successResponse = successResponses.Single();
        successResponse.Headers.Contains("X-Download-Lease").Should().BeTrue();
        var leaseToken = successResponse.Headers.GetValues("X-Download-Lease").FirstOrDefault();
        leaseToken.Should().NotBeNullOrWhiteSpace();

        using var scope = factory.Services.CreateScope();
        var dbContext = scope.ServiceProvider.GetRequiredService<AppDbContext>();

        var group = await dbContext.FileGroups
            .Include(g => g.Leases)
            .FirstOrDefaultAsync(g => g.ShareToken == shareToken);

        group.Should().NotBeNull();
        group!.DownloadCount.Should().Be(1);

        var leases = group.Leases.ToList();
        leases.Count(l => l.Status == LeaseStatus.Completed).Should().BeLessThanOrEqualTo(1);
        leases.Count(l => l.IsActive(DateTime.UtcNow)).Should().Be(0);
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
}