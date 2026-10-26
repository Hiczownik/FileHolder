using System.Text.Json.Serialization;
using FileHolder.Core.Entities;

namespace FileHolder.Core.Dtos;

/// <summary>GET /api/v1/status: what visitors see of the current mode.</summary>
public record ServiceStatusDto(
    [property: JsonPropertyName("mode")] ServiceMode Mode,
    [property: JsonPropertyName("message")] string? Message,
    [property: JsonPropertyName("until")] DateTime? Until
)
{
    public static readonly ServiceStatusDto Normal = new(ServiceMode.Normal, null, null);
}

/// <summary>PUT /admin/mode.</summary>
public record SetServiceModeRequestDto(
    ServiceMode Mode,
    string Reason,
    string? Message = null,
    DateTime? Until = null,
    string? ChangedBy = null
);

public record ServiceModeChangeDto(
    [property: JsonPropertyName("mode")] ServiceMode Mode,
    [property: JsonPropertyName("message")] string? Message,
    [property: JsonPropertyName("until")] DateTime? Until,
    [property: JsonPropertyName("reason")] string Reason,
    [property: JsonPropertyName("changedBy")] string? ChangedBy,
    [property: JsonPropertyName("changedAt")] DateTime ChangedAt
);

/// <summary>GET /admin/mode: the current mode and the latest changes, newest first.</summary>
public record AdminServiceModeResponseDto(
    [property: JsonPropertyName("current")] ServiceStatusDto Current,
    [property: JsonPropertyName("history")] IReadOnlyList<ServiceModeChangeDto> History
);
