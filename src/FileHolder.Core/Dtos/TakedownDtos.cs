using System.Text.Json.Serialization;

namespace FileHolder.Core.Dtos;

/// <summary>POST /admin/takedown. The token travels in the body, never the path, so it stays out of request logs.</summary>
public record TakedownRequestDto(
    string ShareToken,
    string Reason,
    string? ChangedBy = null
);

public enum TakedownStatus
{
    /// <summary>Removed now.</summary>
    Success,

    /// <summary>Removed before; nothing changed.</summary>
    AlreadyTakenDown,

    /// <summary>No bundle has this token (or its tombstone is gone).</summary>
    NotFound,

    /// <summary>Its files were already deleted (expired or used up and purged), so there is nothing left to remove.</summary>
    AlreadyPurged
}

public record TakedownRecordDto(
    [property: JsonPropertyName("shareToken")] string ShareToken,
    [property: JsonPropertyName("takenDownAt")] DateTime TakenDownAt,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("changedBy")] string? ChangedBy,
    [property: JsonPropertyName("fileCount")] int FileCount,
    [property: JsonPropertyName("totalSizeBytes")] long TotalSizeBytes,
    [property: JsonPropertyName("isEncrypted")] bool IsEncrypted
);

/// <summary>
/// What a takedown did. <see cref="FilesNotYetDeleted"/> are files storage didn't delete just now; the purge
/// retries them on its next run.
/// </summary>
public record TakedownResult(
    TakedownStatus Status,
    TakedownRecordDto? Record = null,
    int FilesDeleted = 0,
    int FilesNotYetDeleted = 0
);

public record TakedownResponseDto(
    [property: JsonPropertyName("alreadyTakenDown")] bool AlreadyTakenDown,
    [property: JsonPropertyName("record")] TakedownRecordDto Record,
    [property: JsonPropertyName("filesDeleted")] int FilesDeleted,
    [property: JsonPropertyName("filesNotYetDeleted")] int FilesNotYetDeleted
);
