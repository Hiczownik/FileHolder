using FileHolder.Core.Entities;
using FileHolder.Core.Security;
using FluentAssertions;
using Xunit;

namespace FileHolder.Tests.Unit.Entities;

public class FileGroupTests
{
    [Fact]
    public void IsExpired_ReturnsTrue_WhenExpiresAtIsInPast()
    {
        var now = DateTime.UtcNow;
        var group = new FileGroup
        {
            ExpiresAt = now.AddHours(-1)
        };

        group.IsExpired(now).Should().BeTrue();
    }

    [Fact]
    public void IsExpired_returnsFalse_WhenExpiresAtIsInFuture()
    {
        var now = DateTime.UtcNow;
        var group = new FileGroup
        {
            ExpiresAt = now.AddHours(24)
        };
        
        group.IsExpired(now).Should().BeFalse();       
    }

    [Fact]
    public void IsExpired_ReturnsTrue_WhenDownloadCountReachedMax()
    {
        var now = DateTime.UtcNow;
        var group = new FileGroup
        {
            MaxDownloads = 5,
            DownloadCount = 5
        };
        
        group.IsExpired(now).Should().BeTrue();      
    }

    [Fact]
    public void VerifyPassword_ReturnsTrue_WhenPasswordMatchesHash()
    {
        var rawPassword = "SecretPassword123!";
        var group = new FileGroup
        {
            PasswordHash = CryptoUtils.HashPassword(rawPassword)
        };
        
        group.VerifyPassword(rawPassword).Should().BeTrue();
        group.VerifyPassword("WrongPassword").Should().BeFalse();      
    }

    [Fact]
    public void TotalSizeBytes_CalculatesSumOfChildFileSizes()
    {
        var group = new FileGroup
        {
            Files = new List<SharedFile>
            {
                new() { SizeBytes = 100 },
                new() { SizeBytes = 200 }
            }
        };
        
        group.TotalSizeBytes.Should().Be(300);
    }
}