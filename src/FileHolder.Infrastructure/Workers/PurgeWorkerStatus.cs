using FileHolder.Core.Interfaces;

namespace FileHolder.Infrastructure.Workers;

/// <summary>
/// How the purge worker (<see cref="FileCleanupWorker"/>) is doing, for the purge_worker health check and the
/// fileholder_purge_last_success_age_seconds metric. A run that throws is a failure; a run that completes is a
/// success even if some groups failed to delete, which the purge_backlog check catches instead.
/// </summary>
public sealed class PurgeWorkerStatus(IDateTimeProvider dateTimeProvider)
{
    private readonly object _lock = new();
    private DateTime? _lastSuccessAt;
    private DateTime? _lastFailureAt;
    private string? _lastFailure;

    /// <summary>When this process started watching the worker; until a first success, staleness counts from here.</summary>
    public DateTime StartedAt { get; } = dateTimeProvider.UtcNow;

    public DateTime? LastSuccessAt
    {
        get { lock (_lock) return _lastSuccessAt; }
    }

    public DateTime? LastFailureAt
    {
        get { lock (_lock) return _lastFailureAt; }
    }

    /// <summary>The type of the last run's exception, never its message, which can name storage keys.</summary>
    public string? LastFailure
    {
        get { lock (_lock) return _lastFailure; }
    }

    /// <summary>How long since the last successful run, or since start if there hasn't been one yet.</summary>
    public TimeSpan TimeSinceLastSuccess
    {
        get
        {
            lock (_lock) return dateTimeProvider.UtcNow - (_lastSuccessAt ?? StartedAt);
        }
    }

    public void RecordSuccess()
    {
        lock (_lock) _lastSuccessAt = dateTimeProvider.UtcNow;
    }

    public void RecordFailure(Exception exception)
    {
        lock (_lock)
        {
            _lastFailureAt = dateTimeProvider.UtcNow;
            _lastFailure = exception.GetType().Name;
        }
    }
}
