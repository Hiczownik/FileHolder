using FileHolder.Core.Entities;

namespace FileHolder.Core.Interfaces;

public enum PasswordCheckOutcome
{
    Correct,
    Incorrect,
    LockedOut
}

public record PasswordCheckResult(PasswordCheckOutcome Outcome, DateTime? LockedUntil = null);

/// <summary>
/// Verifies a bundle's password while counting wrong attempts against the bundle,
/// so every endpoint that accepts a password shares one guessing budget.
/// </summary>
public interface IPasswordAttemptGuard
{
    Task<PasswordCheckResult> CheckAsync(FileGroup group, string? password, CancellationToken ct = default);
}
