using FileHolder.Core.Security;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Security;

public class FileSecurityUtilsTests
{
    [Theory]
    [InlineData("evil.exe")]
    [InlineData("EVIL.EXE")]
    [InlineData("evil.exe ")]
    [InlineData("evil.e x e")]
    [InlineData("evil.e\tx\te")]
    [InlineData("evil.e#xe")]
    [InlineData("installer.hta")]
    [InlineData("shortcut.lnk")]
    [InlineData("app.jar")]
    public void IsExtensionForbidden_RejectsNamesThatAreStoredWithAForbiddenExtension(string fileName)
    {
        FileSecurityUtils.IsExtensionForbidden(fileName).Should().BeTrue();
    }

    [Theory]
    [InlineData("report.pdf")]
    [InlineData("archive.tar.gz")]
    [InlineData("exe.pdf")]
    [InlineData("notes")]
    [InlineData("zażółć.txt")]
    public void IsExtensionForbidden_AllowsOrdinaryNames(string fileName)
    {
        FileSecurityUtils.IsExtensionForbidden(fileName).Should().BeFalse();
    }

    [Fact]
    public void SanitizeFileName_OfABypassAttempt_YieldsTheExtensionTheCheckSees()
    {
        // The check and the stored name must agree, or the check can be sidestepped.
        FileSecurityUtils.SanitizeFileName("evil.exe ").Should().Be("evil.exe");
    }
}
