using FileHolder.Api.Admin;
using FileHolder.Api.Validation;
using FileHolder.Core.Dtos;
using FileHolder.Core.Interfaces;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FileHolder.Api.Endpoints;

/// <summary>
/// The owner's controls, on the admin port with the admin token only (<see cref="AdminAccessFilter"/>).
/// scripts/admin.ps1 wraps them; README, *Maintenance Modes*.
/// </summary>
public static class AdminEndpoints
{
    public const int HistoryLength = 20;

    public static void MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
        var admin = app.MapGroup("/admin")
            .AddEndpointFilter<AdminAccessFilter>()
            .ExcludeFromDescription();

        admin.MapGet("/mode", GetMode);

        admin.MapPut("/mode", SetMode)
            .AddEndpointFilter<ValidationFilter<SetServiceModeRequestDto>>();
    }

    public static async Task<Ok<AdminServiceModeResponseDto>> GetMode(IServiceModeProvider serviceMode, CancellationToken ct) =>
        TypedResults.Ok(new AdminServiceModeResponseDto(
            await serviceMode.GetCurrentAsync(ct),
            await serviceMode.GetHistoryAsync(HistoryLength, ct)));

    public static async Task<Ok<ServiceStatusDto>> SetMode(
        SetServiceModeRequestDto dto, IServiceModeProvider serviceMode, CancellationToken ct) =>
        TypedResults.Ok(await serviceMode.SetAsync(dto, ct));
}
