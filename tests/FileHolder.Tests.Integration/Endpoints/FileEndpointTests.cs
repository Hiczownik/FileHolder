using System.Net;
using System.Net.Http.Json;
using FileHolder.Core.Dtos;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;

namespace FileHolder.Tests.Integration.Endpoints;

public class FileEndpointTests(CustomWebApplicationFactory factory) : IClassFixture<CustomWebApplicationFactory>
{
    private readonly HttpClient _client = factory.CreateClient();
    private readonly CustomWebApplicationFactory _factory = factory;

    [Fact]
    public async Task GetPresignedUrl_Returns200AndPresignedUrl_WhenPayloadIsValid()
    {
        var request = new CreatePresignedUrlRequestDto(
            FileName: "architecture_diagram.pdf",
            ContentType: "application/pdf",
            SizeBytes: 1024,
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: null
        );
        
        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var result = await response.Content.ReadFromJsonAsync<PresignedUrlResponseDto>();
        result.Should().NotBeNull();
        result.UploadUrl.Should().Contain("http://localhost:9000");
        result.StorageKey.Should().Contain("architecture_diagram.pdf");
        result.UploadToken.Should().NotBeEmpty();
    }

    [Fact]
    public async Task GetPresignedUrl_Returns400BadRequest_WhenFileExtensionIsForbidden()
    {
        var request = new CreatePresignedUrlRequestDto(
            FileName: "malicious_script.exe",
            ContentType: "application/x-msdownload",
            SizeBytes: 1024,
            ExpireInHours: 24,
            MaxDownloads: 5,
            Password: null
        );
        
        var response = await _client.PostAsJsonAsync("/api/v1/files/presign", request);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
    
    [Fact]
    public async Task GetMetadata_Returns404NotFound_WhenTokenDoesNotExist()
    {
        var response = await _client.GetAsync("/api/v1/files/non_existent_token_999");
        
        response.StatusCode.Should().Be(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task ConfirmAndGetMetadataFlow_SuccessfullyStoresAndRetrievesFile()
    {
        var confirmRequest = new ConfirmUploadRequestDto(
            UploadToken: "test_upload_token",
            StorageKey: "uploads/test_key.pdf",
            FileName: "test_report.pdf",
            ContentType: "application/pdf",
            SizeBytes: 1024,
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
        
        var metadata = await metadataResponse.Content.ReadFromJsonAsync<FileMetadataResponseDto>();
        metadata.Should().NotBeNull();
        metadata.FileName.Should().Be("test_report.pdf");
        metadata.RequiresPassword.Should().BeFalse();
        metadata.RemainingDownloads.Should().Be(10);
        metadata.IsExpired.Should().BeFalse();       
    }
}