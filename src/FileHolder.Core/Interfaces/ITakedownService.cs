using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

/// <summary>The owner removing a bundle for abuse or a legal request (README, *Takedown*).</summary>
public interface ITakedownService
{
    /// <summary>
    /// Closes the bundle, deletes its files at once (cutting off downloads in progress), reduces it to a tombstone
    /// whose link says it was removed, and records why.
    /// </summary>
    Task<TakedownResult> TakeDownAsync(TakedownRequestDto request, CancellationToken ct = default);

    /// <summary>The latest takedowns, newest first.</summary>
    Task<IReadOnlyList<TakedownRecordDto>> GetHistoryAsync(int count, CancellationToken ct = default);
}
