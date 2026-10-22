using System.Text.RegularExpressions;
using FluentAssertions;

namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// Every container image the app runs or builds from is pinned to an exact version and its digest, so a pull or a
/// fresh CI runner can never silently get a different image (#74).
/// </summary>
public class PinnedImagesTests
{
    // Matches an image pinned by a digest, with a tag that names the version it holds:
    // "postgres:17.11-alpine3.24@sha256:<64 hex>" and "pgsty/silo:RELEASE.2026-10-18T00-00-00Z@sha256:<64 hex>" match;
    // "pgsty/silo:latest", "postgres:17-alpine" (only a major version) and any tag without a digest don't. The digest
    // is what fixes the image; the tag's version is for people and Dependabot to read.
    // https://regex101.com/?regex=%5E%5B%5E%5Cs%3A%40%5D%2B%3A(%5B%5E%5Cs%40%5D*%5Cd%2B%5C.%5Cd%2B%5B%5E%5Cs%40%5D*%7CRELEASE%5C.%5Cd%7B4%7D-%5Cd%7B2%7D-%5Cd%7B2%7DT%5B%5E%5Cs%40%5D%2B)%40sha256%3A%5B0-9a-f%5D%7B64%7D%24
    private static readonly Regex PinnedImage = new(
        @"^[^\s:@]+:([^\s@]*\d+\.\d+[^\s@]*|RELEASE\.\d{4}-\d{2}-\d{2}T[^\s@]+)@sha256:[0-9a-f]{64}$",
        RegexOptions.None,
        TimeSpan.FromSeconds(1));

    public static TheoryData<string> ComposeImageLines()
    {
        var images = File.ReadAllLines(Path.Combine(ComposeImages.RepositoryRoot, ComposeImages.ComposeFileName))
            .Select(line => line.Trim())
            .Where(line => line.StartsWith("image:", StringComparison.Ordinal))
            .Select(line => line["image:".Length..].Trim());
        return new TheoryData<string>(images);
    }

    public static TheoryData<string> DockerfileBaseImages()
    {
        var images = new[] { "src/FileHolder.Api/Dockerfile", "src/fileholder-ui/Dockerfile" }
            .SelectMany(path => File.ReadAllLines(Path.Combine(ComposeImages.RepositoryRoot, path)))
            .Where(line => line.StartsWith("FROM ", StringComparison.Ordinal))
            .Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries)[1]);
        return new TheoryData<string>(images);
    }

    [Theory]
    [MemberData(nameof(ComposeImageLines))]
    public void ComposeImage_IsPinnedToAVersionAndDigest(string image)
    {
        PinnedImage.IsMatch(image).Should().BeTrue($"'{image}' in docker-compose.yml must be pinned as name:version@sha256:digest");
    }

    [Theory]
    [MemberData(nameof(DockerfileBaseImages))]
    public void DockerfileBaseImage_IsPinnedToAVersionAndDigest(string image)
    {
        PinnedImage.IsMatch(image).Should().BeTrue($"base image '{image}' must be pinned as name:version@sha256:digest");
    }

    [Fact]
    public void TestImages_AreTheComposeImages()
    {
        ComposeImages.Postgres.Should().StartWith("postgres:");
        ComposeImages.Silo.Should().StartWith("pgsty/silo:");
        ComposeImages.ImageOf("minio-init").Should().Be(ComposeImages.Silo, "both services run the same Silo release");
    }
}
