using FileHolder.Core.Dtos;

namespace FileHolder.Core.Interfaces;

/// <summary>The current <see cref="Entities.ServiceMode"/>, read from the database and cached briefly.</summary>
public interface IServiceModeProvider
{
    /// <summary>The current mode, at most <see cref="Configuration.ServiceModeRules.CacheLifetime"/> old.</summary>
    Task<ServiceStatusDto> GetCurrentAsync(CancellationToken ct = default);

    /// <summary>Records a change, logs it, and makes this instance use it at once.</summary>
    Task<ServiceStatusDto> SetAsync(SetServiceModeRequestDto change, CancellationToken ct = default);

    /// <summary>The latest changes, newest first.</summary>
    Task<IReadOnlyList<ServiceModeChangeDto>> GetHistoryAsync(int count, CancellationToken ct = default);
}
