using FileHolder.Core.Configuration;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Configuration;

public class PasswordLockoutTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(5)]
    public void LockoutAfter_FreeAttempts_DoesNotLock(int failedAttempts)
    {
        PasswordLockout.LockoutAfter(failedAttempts).Should().BeNull();
    }

    [Theory]
    [InlineData(6, 1)]
    [InlineData(7, 2)]
    [InlineData(8, 4)]
    [InlineData(11, 32)]
    [InlineData(12, 60)]
    [InlineData(13, 60)]
    public void LockoutAfter_DoublesFromOneMinute_UpToTheCap(int failedAttempts, int expectedMinutes)
    {
        PasswordLockout.LockoutAfter(failedAttempts).Should().Be(TimeSpan.FromMinutes(expectedMinutes));
    }

    [Theory]
    [InlineData(50)]
    [InlineData(int.MaxValue)]
    public void LockoutAfter_ManyAttempts_StaysAtTheCap(int failedAttempts)
    {
        PasswordLockout.LockoutAfter(failedAttempts).Should().Be(PasswordLockout.MaxLockout);
    }
}
