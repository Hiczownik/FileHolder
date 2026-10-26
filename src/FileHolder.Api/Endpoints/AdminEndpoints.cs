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

        admin.MapPost("/takedown", TakeDown)
            .AddEndpointFilter<ValidationFilter<TakedownRequestDto>>();

        admin.MapGet("/takedowns", GetTakedowns);
    }

    public static async Task<Ok<AdminServiceModeResponseDto>> GetMode(IServiceModeProvider serviceMode, CancellationToken ct) =>
        TypedResults.Ok(new AdminServiceModeResponseDto(
            await serviceMode.GetCurrentAsync(ct),
            await serviceMode.GetHistoryAsync(HistoryLength, ct)));

    public static async Task<Ok<ServiceStatusDto>> SetMode(
        SetServiceModeRequestDto dto, IServiceModeProvider serviceMode, CancellationToken ct) =>
        TypedResults.Ok(await serviceMode.SetAsync(dto, ct));

    /// <summary>
    /// 200 with what was done (or, if it was removed before, the earlier record); 404 for an unknown token; 409 when
    /// its files are already gone because it expired or was used up.
    /// </summary>
    public static async Task<Results<Ok<TakedownResponseDto>, NotFound, ProblemHttpResult>> TakeDown(
        TakedownRequestDto dto, ITakedownService takedowns, CancellationToken ct)
    {
        var result = await takedowns.TakeDownAsync(dto, ct);

        return result.Status switch
        {
            TakedownStatus.Success or TakedownStatus.AlreadyTakenDown when result.Record is not null => TypedResults.Ok(
                new TakedownResponseDto(
                    result.Status == TakedownStatus.AlreadyTakenDown, result.Record, result.FilesDeleted, result.FilesNotYetDeleted)),
            TakedownStatus.AlreadyPurged => TypedResults.Problem(
                detail: "This bundle's files were already deleted (it expired or ran out of downloads), so there is nothing to take down.",
                statusCode: StatusCodes.Status409Conflict,
                title: "Already Deleted"),
            _ => TypedResults.NotFound(),
        };
    }

    public static async Task<Ok<IReadOnlyList<TakedownRecordDto>>> GetTakedowns(ITakedownService takedowns, CancellationToken ct) =>
        TypedResults.Ok(await takedowns.GetHistoryAsync(HistoryLength, ct));
}
