namespace FileHolder.Core.Configuration;

/// <summary>
/// Per-bundle limit on password guessing. The per-IP rate limiter alone can be sidestepped by changing
/// address, so wrong passwords are also counted on the bundle itself.
/// </summary>
public static class PasswordLockout
{
    /// <summary>
    /// Wrong passwords allowed before any lockout, so a recipient's typos cost nothing.
    /// </summary>
    public const int FreeAttempts = 5;

    public static readonly TimeSpan FirstLockout = TimeSpan.FromMinutes(1);

    /// <summary>
    /// Caps the lockout, because anyone holding the link can trigger it on purpose and lock real recipients out.
    /// </summary>
    public static readonly TimeSpan MaxLockout = TimeSpan.FromHours(1);

    /// <summary>
    /// Held while a past-the-free-attempts guess is being verified, so no parallel guess can be verified
    /// alongside it. Long enough to outlast bcrypt, shorter than <see cref="FirstLockout"/> (which replaces
    /// it on a wrong guess), and short so a request that dies mid-check doesn't lock recipients out for long.
    /// </summary>
    public static readonly TimeSpan VerificationHold = TimeSpan.FromSeconds(30);

    /// <summary>
    /// How long a bundle stays locked after its <paramref name="failedAttempts"/>-th wrong password:
    /// nothing within the free attempts, then 1, 2, 4, ... minutes up to <see cref="MaxLockout"/>.
    /// </summary>
    public static TimeSpan? LockoutAfter(int failedAttempts)
    {
        // Compared before subtracting: int.MinValue - FreeAttempts wraps around to a huge positive number.
        if (failedAttempts <= FreeAttempts)
        {
            return null;
        }

        int excess = failedAttempts - FreeAttempts;

        // Past 2^10 minutes the cap applies anyway; stopping here keeps the shift from overflowing.
        if (excess > 10)
        {
            return MaxLockout;
        }

        var lockout = FirstLockout * (1 << (excess - 1));
        return lockout < MaxLockout ? lockout : MaxLockout;
    }
}
