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

    private const string KAuth = "kAuth_derived_in_the_browser_0123456789abcd";

    [Fact]
    public void HashAuthKey_StoresATaggedSha256_ThatVerifiesOnlyThatKey()
    {
        var hash = CryptoUtils.HashAuthKey(KAuth);

        // Not bcrypt (#78): kAuth is random, so a slow hash only costs the server.
        hash.Should().StartWith("sha256:").And.NotStartWith("$2");
        CryptoUtils.VerifyPassword(KAuth, hash).Should().BeTrue();
        CryptoUtils.VerifyPassword(KAuth[..^1] + "e", hash).Should().BeFalse();
        CryptoUtils.VerifyPassword("", hash).Should().BeFalse();
    }

    [Fact]
    public void VerifyPassword_StillChecksBcryptHashes_NextToAuthKeyHashes()
    {
        // Plain bundles keep bcrypt; a typed password must stay slow to guess offline.
        var bcrypt = CryptoUtils.HashPassword(KAuth);

        bcrypt.Should().StartWith("$2");
        CryptoUtils.VerifyPassword(KAuth, bcrypt).Should().BeTrue();
        CryptoUtils.VerifyPassword(KAuth, CryptoUtils.HashAuthKey("another_kAuth_derived_in_browser_0123456789")).Should().BeFalse();
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
