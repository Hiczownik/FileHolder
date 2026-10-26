using System.Diagnostics;
using System.Diagnostics.Metrics;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Core.Entities;
using FileHolder.Core.Interfaces;
using FileHolder.Infrastructure.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// The current <see cref="ServiceMode"/>: the latest <see cref="ServiceModeChange"/> row, read at most every
/// <see cref="ServiceModeRules.CacheLifetime"/>, so checking it on every request costs nothing. A change made
/// through this instance applies here at once; other instances see it within the cache lifetime.
/// Exposed as fileholder_service_mode{mode} (1 for the current mode, 0 for the others) and
/// fileholder_service_mode_changes_total.
/// </summary>
public sealed class ServiceModeProvider : IServiceModeProvider, IDisposable
{
    public const string ModeInstrument = "fileholder.service.mode";
    public const string ChangesInstrument = "fileholder.service.mode_changes";

    private readonly IServiceScopeFactory _scopeFactory;
    private readonly IDateTimeProvider _dateTimeProvider;
    private readonly ILogger<ServiceModeProvider> _logger;
    private readonly Counter<long> _changes;
    private readonly SemaphoreSlim _refresh = new(1, 1);

    private ServiceStatusDto? _current;
    private long _readAtTimestamp;

    public ServiceModeProvider(
        IServiceScopeFactory scopeFactory,
        IDateTimeProvider dateTimeProvider,
        IMeterFactory meterFactory,
        ILogger<ServiceModeProvider> logger)
    {
        _scopeFactory = scopeFactory;
        _dateTimeProvider = dateTimeProvider;
        _logger = logger;

        var meter = meterFactory.Create(StorageLifecycleStatus.MeterName);
        meter.CreateObservableGauge(
            ModeInstrument,
            () => Measurements(Volatile.Read(ref _current)),
            description: "1 for the service mode in force (Normal, UploadsPaused, ReadOnly, Closed), 0 for the others.");
        _changes = meter.CreateCounter<long>(
            ChangesInstrument,
            description: "Service mode changes made through this API instance.");
    }

    public async Task<ServiceStatusDto> GetCurrentAsync(CancellationToken ct = default)
    {
        var cached = Volatile.Read(ref _current);
        if (cached is not null && IsFresh())
        {
            return cached;
        }

        await _refresh.WaitAsync(ct);
        try
        {
            cached = Volatile.Read(ref _current);
            if (cached is not null && IsFresh())
            {
                return cached;
            }

            try
            {
                return Store(await ReadLatestAsync(ct));
            }
            catch (Exception ex) when (cached is not null && ex is not OperationCanceledException)
            {
                // Keep the last known mode rather than failing every request over it; the database being down
                // shows up in the health checks anyway.
                _logger.LogWarning(ex, "Couldn't read the service mode; keeping {Mode}.", cached.Mode);
                return cached;
            }
        }
        finally
        {
            _refresh.Release();
        }
    }

    public async Task<ServiceStatusDto> SetAsync(SetServiceModeRequestDto change, CancellationToken ct = default)
    {
        var previous = await GetCurrentAsync(ct);

        var row = new ServiceModeChange
        {
            Mode = change.Mode,
            Message = string.IsNullOrWhiteSpace(change.Message) ? null : change.Message.Trim(),
            Until = change.Until?.ToUniversalTime(),
            Reason = change.Reason.Trim(),
            ChangedBy = string.IsNullOrWhiteSpace(change.ChangedBy) ? null : change.ChangedBy.Trim(),
            ChangedAt = _dateTimeProvider.UtcNow,
        };

        using (var scope = _scopeFactory.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
            db.ServiceModeChanges.Add(row);
            await db.SaveChangesAsync(ct);
        }

        _changes.Add(1, new KeyValuePair<string, object?>("mode", row.Mode.ToString()));
        // A warning, so it stands out among the request logs: someone changed what visitors can do.
        _logger.LogWarning("Service mode changed from {PreviousMode} to {Mode} by {ChangedBy}: {Reason}",
            previous.Mode, row.Mode, row.ChangedBy ?? "(not given)", row.Reason);

        await _refresh.WaitAsync(ct);
        try
        {
            return Store(ToStatus(row));
        }
        finally
        {
            _refresh.Release();
        }
    }

    public async Task<IReadOnlyList<ServiceModeChangeDto>> GetHistoryAsync(int count, CancellationToken ct = default)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        return await db.ServiceModeChanges
            .AsNoTracking()
            .OrderByDescending(c => c.Id)
            .Take(count)
            .Select(c => new ServiceModeChangeDto(c.Mode, c.Message, c.Until, c.Reason, c.ChangedBy, c.ChangedAt))
            .ToListAsync(ct);
    }

    private async Task<ServiceStatusDto> ReadLatestAsync(CancellationToken ct)
    {
        using var scope = _scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var latest = await db.ServiceModeChanges
            .AsNoTracking()
            .OrderByDescending(c => c.Id)
            .FirstOrDefaultAsync(ct);
        return latest is null ? ServiceStatusDto.Normal : ToStatus(latest);
    }

    private static ServiceStatusDto ToStatus(ServiceModeChange change) =>
        new(change.Mode, change.Message, change.Until);

    private ServiceStatusDto Store(ServiceStatusDto status)
    {
        Volatile.Write(ref _readAtTimestamp, Stopwatch.GetTimestamp());
        Volatile.Write(ref _current, status);
        return status;
    }

    // Real time, not the injected clock: this is how stale the copy is, not the app's notion of "now".
    private bool IsFresh() =>
        Stopwatch.GetElapsedTime(Volatile.Read(ref _readAtTimestamp)) < ServiceModeRules.CacheLifetime;

    public void Dispose() => _refresh.Dispose();

    /// <summary>None until the mode is first read, rather than claiming Normal before it's known.</summary>
    private static IEnumerable<Measurement<int>> Measurements(ServiceStatusDto? current) =>
        current is null
            ? []
            : Enum.GetValues<ServiceMode>().Select(mode =>
                new Measurement<int>(mode == current.Mode ? 1 : 0, new KeyValuePair<string, object?>("mode", mode.ToString())));
}
