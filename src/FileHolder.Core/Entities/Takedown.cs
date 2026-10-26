namespace FileHolder.Core.Entities;

/// <summary>
/// The record of one takedown: which link the owner removed, when and why. Kept after the bundle's tombstone is
/// deleted, so an abuse or legal request can still be answered ("was this link removed, and when?"). Holds nothing
/// of the bundle's contents: no title, file names or keys, only counts.
/// </summary>
public class Takedown
{
    public long Id { get; set; }

    /// <summary>The removed link's token. Dead from the moment of the takedown, so no longer a secret.</summary>
    public string ShareToken { get; set; } = string.Empty;

    public Guid FileGroupId { get; set; }

    /// <summary>Why: the abuse report, the legal request. Only in the log and the admin endpoint.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>Who took it down, as they said.</summary>
    public string? ChangedBy { get; set; }

    public DateTime TakenDownAt { get; set; }

    public int FileCount { get; set; }
    public long TotalSizeBytes { get; set; }
    public bool IsEncrypted { get; set; }
}
