using System.Text.Json.Serialization;

namespace FileHolder.Core.Dtos;

/// <summary>POST /api/v1/files/access-codes/check: which limits a code unlocks, before uploading.</summary>
public record AccessCodeCheckRequestDto(string? Code);

/// <summary>POST /admin/access-codes. Expires after <c>AccessCodeRules.DefaultLifetime</c> unless told otherwise.</summary>
public record CreateAccessCodeRequestDto(string Label, int? ExpiresInDays = null, bool NoExpiry = false);

/// <summary>POST /admin/access-codes/{label}/extend: valid for this many days from now (default 30), or with no expiry.</summary>
public record ExtendAccessCodeRequestDto(int? Days = null, bool NoExpiry = false);

/// <summary>The new code, shown this once: only its hash is stored.</summary>
public record AccessCodeCreatedDto(
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("expiresAt")] DateTime? ExpiresAt
);

public record AccessCodeDto(
    [property: JsonPropertyName("label")] string Label,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("createdAt")] DateTime CreatedAt,
    [property: JsonPropertyName("expiresAt")] DateTime? ExpiresAt,
    [property: JsonPropertyName("revokedAt")] DateTime? RevokedAt,
    [property: JsonPropertyName("bundleCount")] int BundleCount,
    [property: JsonPropertyName("bytesUploaded")] long BytesUploaded,
    [property: JsonPropertyName("firstUsedAt")] DateTime? FirstUsedAt,
    [property: JsonPropertyName("lastUsedAt")] DateTime? LastUsedAt
);

/// <summary>
/// What an upload is allowed beyond the request's own validation (#169): the longest expiry confirm may ask for, and
/// the access code to count the bundle against. Unrestricted when access codes are off.
/// </summary>
public record UploadTier(int? MaxExpiryHours, Guid? AccessCodeId)
{
    public static readonly UploadTier Unrestricted = new(null, null);
}
