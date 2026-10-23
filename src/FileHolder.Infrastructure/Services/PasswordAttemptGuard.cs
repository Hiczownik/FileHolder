using System.Diagnostics;
using FileHolder.Core.Configuration;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using FileHolder.Infrastructure.Diagnostics;
using Microsoft.EntityFrameworkCore;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// Each check is a <c>password.check</c> span that records the decision (<see cref="Decisions"/>), never the attempt.
/// </summary>
public class PasswordAttemptGuard(
    AppDbContext dbContext,
    IDateTimeProvider dateTimeProvider)
    : IPasswordAttemptGuard
{
    public static class Decisions
    {
        public const string NotRequired = "not_required";
        public const string RefusedLockedOut = "refused_locked_out";
        public const string RefusedHeld = "refused_held";
        public const string Correct = "correct";
        public const string FreeAttemptUsed = "free_attempt_used";
        public const string LockoutApplied = "lockout_applied";
    }

    private const string DecisionTag = "fileholder.password.decision";

    private readonly AppDbContext _dbContext = dbContext;
    private readonly IDateTimeProvider _dateTimeProvider = dateTimeProvider;

    public async Task<PasswordCheckResult> CheckAsync(FileGroup group, string? password, CancellationToken ct = default)
    {
        using var activity = FileHolderTracing.StartStep("password.check");
        try
        {
            return await CheckInSpanAsync(activity, group, password, ct);
        }
        catch (Exception ex)
        {
            activity.RecordFailure(ex);
            throw;
        }
    }

    private async Task<PasswordCheckResult> CheckInSpanAsync(Activity? activity, FileGroup group, string? password, CancellationToken ct)
    {
        if (!group.RequiresPassword)
        {
            activity?.SetTag(DecisionTag, Decisions.NotRequired);
            return new PasswordCheckResult(PasswordCheckOutcome.Correct);
        }

        var now = _dateTimeProvider.UtcNow;

        // Refuse before verifying: a correct guess must not get through a lockout, and bcrypt isn't spent on it.
        if (group.PasswordLockedUntil > now)
        {
            activity?.SetTag(DecisionTag, Decisions.RefusedLockedOut);
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

            activity?.SetTag(DecisionTag, Decisions.RefusedHeld);
            return new PasswordCheckResult(PasswordCheckOutcome.LockedOut, lockedUntil);
        }

        bool verified;
        using (FileHolderTracing.StartStep("password.verify"))
        {
            verified = group.VerifyPassword(password);
        }

        if (verified)
        {
            // Also releases the hold this attempt may have set.
            await _dbContext.FileGroups
                .Where(g => g.Id == group.Id)
                .ExecuteUpdateAsync(s => s
                    .SetProperty(g => g.FailedPasswordAttempts, 0)
                    .SetProperty(g => g.PasswordLockedUntil, (DateTime?)null), ct);

            activity?.SetTag(DecisionTag, Decisions.Correct);
            return new PasswordCheckResult(PasswordCheckOutcome.Correct);
        }

        int failedAttempts = await _dbContext.FileGroups
            .Where(g => g.Id == group.Id)
            .Select(g => g.FailedPasswordAttempts)
            .FirstAsync(ct);

        activity?.SetTag("fileholder.password.failed_attempts", failedAttempts);

        var lockout = PasswordLockout.LockoutAfter(failedAttempts);
        if (lockout is null)
        {
            activity?.SetTag(DecisionTag, Decisions.FreeAttemptUsed);
            return new PasswordCheckResult(PasswordCheckOutcome.Incorrect);
        }

        var lockedUntilAfterFailure = now + lockout.Value;

        // Replaces the hold with the real lockout, which is always longer. Only ever extend: a slower
        // concurrent request must not shorten a lock a later attempt already set.
        await _dbContext.FileGroups
            .Where(g => g.Id == group.Id && (g.PasswordLockedUntil == null || g.PasswordLockedUntil < lockedUntilAfterFailure))
            .ExecuteUpdateAsync(s => s.SetProperty(g => g.PasswordLockedUntil, lockedUntilAfterFailure), ct);

        activity?.SetTag(DecisionTag, Decisions.LockoutApplied)
            .SetTag("fileholder.password.lockout_seconds", (int)lockout.Value.TotalSeconds);
        return new PasswordCheckResult(PasswordCheckOutcome.Incorrect, lockedUntilAfterFailure);
    }
}
