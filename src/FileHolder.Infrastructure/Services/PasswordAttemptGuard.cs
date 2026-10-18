using FileHolder.Core.Configuration;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Infrastructure.Services;

public class PasswordAttemptGuard(
    AppDbContext dbContext,
    IDateTimeProvider dateTimeProvider)
    : IPasswordAttemptGuard
{
    private readonly AppDbContext _dbContext = dbContext;
    private readonly IDateTimeProvider _dateTimeProvider = dateTimeProvider;

    public async Task<PasswordCheckResult> CheckAsync(FileGroup group, string? password, CancellationToken ct = default)
    {
        if (!group.RequiresPassword)
        {
            return new PasswordCheckResult(PasswordCheckOutcome.Correct);
        }

        var now = _dateTimeProvider.UtcNow;

        // Refuse before verifying: a correct guess must not get through a lockout, and bcrypt isn't spent on it.
        if (group.PasswordLockedUntil > now)
        {
            return new PasswordCheckResult(PasswordCheckOutcome.LockedOut, group.PasswordLockedUntil);
        }

        if (group.VerifyPassword(password))
        {
            if (group.FailedPasswordAttempts > 0 || group.PasswordLockedUntil != null)
            {
                await _dbContext.FileGroups
                    .Where(g => g.Id == group.Id)
                    .ExecuteUpdateAsync(s => s
                        .SetProperty(g => g.FailedPasswordAttempts, 0)
                        .SetProperty(g => g.PasswordLockedUntil, (DateTime?)null), ct);
            }

            return new PasswordCheckResult(PasswordCheckOutcome.Correct);
        }

        // Increment in the database rather than from the loaded value, so concurrent wrong guesses all count.
        await _dbContext.FileGroups
            .Where(g => g.Id == group.Id)
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.FailedPasswordAttempts, g => g.FailedPasswordAttempts + 1), ct);

        int failedAttempts = await _dbContext.FileGroups
            .Where(g => g.Id == group.Id)
            .Select(g => g.FailedPasswordAttempts)
            .FirstAsync(ct);

        var lockout = PasswordLockout.LockoutAfter(failedAttempts);
        if (lockout is null)
        {
            return new PasswordCheckResult(PasswordCheckOutcome.Incorrect);
        }

        var lockedUntil = now + lockout.Value;

        // Only ever extend: a slower concurrent request must not shorten a lock a later attempt already set.
        await _dbContext.FileGroups
            .Where(g => g.Id == group.Id && (g.PasswordLockedUntil == null || g.PasswordLockedUntil < lockedUntil))
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.PasswordLockedUntil, lockedUntil), ct);

        return new PasswordCheckResult(PasswordCheckOutcome.Incorrect, lockedUntil);
    }
}
