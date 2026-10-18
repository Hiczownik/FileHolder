using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;

namespace FileHolder.Core.Interfaces;

public interface IDownloadSessionService
{
    /// <summary>
    /// Verifies access and atomically consumes one of the group's downloads, returning a session
    /// that can fetch every file in the group until it expires.
    /// </summary>
    Task<OpenDownloadSessionResult> OpenSessionAsync(string shareToken, string? password, CancellationToken ct = default);

    /// <summary>
    /// Returns the session with its group and files loaded, or null when it does not exist,
    /// belongs to another share token, has expired, or its storage has already been purged.
    /// </summary>
    Task<DownloadSession?> GetActiveSessionAsync(string shareToken, Guid sessionId, CancellationToken ct = default);
}
