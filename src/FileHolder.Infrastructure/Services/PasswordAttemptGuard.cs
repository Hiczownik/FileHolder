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

        // The loaded row may already be stale, so the attempt is claimed in the database before bcrypt runs.
        // Once the free attempts are used up, the claim also sets a short hold, and Postgres re-checks the
        // WHERE clause for every request that waited on the row lock, so parallel guesses can't all slip
        // through between reading the lock and setting it: exactly one is verified, the rest are refused.
        var holdUntil = now + PasswordLockout.VerificationHold;
        int claimed = await _dbContext.FileGroups
            .Where(g => g.Id == group.Id && (g.PasswordLockedUntil == null || g.PasswordLockedUntil <= now))
            .ExecuteUpdateAsync(s => s
                .SetProperty(g => g.FailedPasswordAttempts, g => g.FailedPasswordAttempts + 1)
                .SetProperty(g => g.PasswordLockedUntil, g => g.FailedPasswordAttempts + 1 > PasswordLockout.FreeAttempts
                    ? (DateTime?)holdUntil
                    : g.PasswordLockedUntil), ct);

        if (claimed == 0)
        {
            var lockedUntil = await _dbContext.FileGroups
                .Where(g => g.Id == group.Id)
                .Select(g => g.PasswordLockedUntil)
                .FirstAsync(ct);

            return new PasswordCheckResult(PasswordCheckOutcome.LockedOut, lockedUntil);
        }

        if (group.VerifyPassword(password))
        {
            // Also releases the hold this attempt may have set.
            await _dbContext.FileGroups
                .Where(g => g.Id == group.Id)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(g => g.FailedPasswordAttempts, 0)
                    .SetProperty(g => g.PasswordLockedUntil, (DateTime?)null), ct);

            return new PasswordCheckResult(PasswordCheckOutcome.Correct);
        }

        int failedAttempts = await _dbContext.FileGroups
            .Where(g => g.Id == group.Id)
            .Select(g => g.FailedPasswordAttempts)
            .FirstAsync(ct);

        var lockout = PasswordLockout.LockoutAfter(failedAttempts);
        if (lockout is null)
        {
            return new PasswordCheckResult(PasswordCheckOutcome.Incorrect);
        }

        var lockedUntilAfterFailure = now + lockout.Value;

        // Replaces the hold with the real lockout, which is always longer. Only ever extend: a slower
        // concurrent request must not shorten a lock a later attempt already set.
        await _dbContext.FileGroups
            .Where(g => g.Id == group.Id && (g.PasswordLockedUntil == null || g.PasswordLockedUntil < lockedUntilAfterFailure))
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.PasswordLockedUntil, lockedUntilAfterFailure), ct);

        return new PasswordCheckResult(PasswordCheckOutcome.Incorrect, lockedUntilAfterFailure);
    }
}
