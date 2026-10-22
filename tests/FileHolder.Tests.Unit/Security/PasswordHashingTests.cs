using FileHolder.Core.Security;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Security;

/// <summary>Bundle passwords: every character counts, not only bcrypt's first 72 bytes (#53).</summary>
public class PasswordHashingTests
{
    [Fact]
    public void VerifyPassword_TellsApartLongPasswords_ThatShareTheFirst72Bytes()
    {
        var prefix = new string('a', 72);
        var hash = CryptoUtils.HashPassword(prefix + "-one");

        CryptoUtils.VerifyPassword(prefix + "-one", hash).Should().BeTrue();
        CryptoUtils.VerifyPassword(prefix + "-two", hash).Should().BeFalse();
        CryptoUtils.VerifyPassword(prefix, hash).Should().BeFalse();
    }

    [Fact]
    public void VerifyPassword_TellsApartMultiByteValues_ThatDifferOnlyInTheLastCharacter()
    {
        // 99 four-byte characters are 396 UTF-8 bytes, far past bcrypt's limit; the validator allows 100 characters.
        var prefix = string.Concat(Enumerable.Repeat("😀", 49));
        var hash = CryptoUtils.HashPassword(prefix + "x");

        CryptoUtils.VerifyPassword(prefix + "x", hash).Should().BeTrue();
        CryptoUtils.VerifyPassword(prefix + "y", hash).Should().BeFalse();
    }

    [Fact]
    public void VerifyPassword_ChecksShortPasswordsAsBefore()
    {
        var hash = CryptoUtils.HashPassword("1234");

        CryptoUtils.VerifyPassword("1234", hash).Should().BeTrue();
        CryptoUtils.VerifyPassword("12345", hash).Should().BeFalse();
        CryptoUtils.VerifyPassword("", hash).Should().BeFalse();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void HashPassword_StoresNoHash_ForNoPassword(string? password)
    {
        CryptoUtils.HashPassword(password).Should().BeNull();
    }
}
