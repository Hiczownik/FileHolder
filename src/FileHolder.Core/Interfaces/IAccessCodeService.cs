using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

public enum AccessCodeStatus
{
    /// <summary>No code was given.</summary>
    None,

    /// <summary>A known code that hasn't expired or been revoked.</summary>
    Valid,

    /// <summary>Unknown, expired or revoked: the caller is told only that it isn't valid.</summary>
    Invalid
}

public record AccessCodeResolution(AccessCodeStatus Status, Guid? AccessCodeId = null);

/// <summary>Access codes (#169): checking one an upload brings, and the owner's admin commands.</summary>
public interface IAccessCodeService
{
    Task<AccessCodeResolution> ResolveAsync(string? code, CancellationToken ct = default);

    /// <summary>A new code under <paramref name="request"/>'s label; its text is returned this once.</summary>
    Task<AccessCodeCreatedDto> CreateAsync(CreateAccessCodeRequestDto request, CancellationToken ct = default);

    Task<IReadOnlyList<AccessCodeDto>> ListAsync(CancellationToken ct = default);

    /// <summary>Null when no code has the label.</summary>
    Task<AccessCodeDto?> ExtendAsync(string label, ExtendAccessCodeRequestDto request, CancellationToken ct = default);

    /// <summary>Null when no code has the label.</summary>
    Task<AccessCodeDto?> RevokeAsync(string label, CancellationToken ct = default);
}
