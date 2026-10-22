using FileHolder.Core.Configuration;
using FileHolder.Core.Interfaces;

namespace FileHolder.Api.Health;

/// <summary>
/// Keeps a health check's answer for <see cref="HealthThresholds.ProbeCacheDuration"/>, so frequent probes (compose,
/// monitoring, the metrics publisher) don't each run the same database query. One per cached value (a singleton).
/// </summary>
public sealed class ProbeCache<T>(IDateTimeProvider dateTimeProvider) : IDisposable
{
    private sealed record Entry(T Value, DateTime At);

    private readonly SemaphoreSlim _refresh = new(1, 1);
    private Entry? _entry;

    public async Task<T> GetAsync(Func<CancellationToken, Task<T>> load, CancellationToken ct)
    {
        if (Fresh(Volatile.Read(ref _entry)) is { } hit)
        {
            return hit.Value;
        }

        await _refresh.WaitAsync(ct);
        try
        {
            // Another probe may have refreshed it while this one waited.
            if (Fresh(Volatile.Read(ref _entry)) is { } refreshed)
            {
                return refreshed.Value;
            }

            var value = await load(ct);
            Volatile.Write(ref _entry, new Entry(value, dateTimeProvider.UtcNow));
            return value;
        }
        finally
        {
            _refresh.Release();
        }
    }

    public void Dispose() => _refresh.Dispose();

    /// <summary>The entry if it is recent enough. One from the future (a clock set back) counts as stale.</summary>
    private Entry? Fresh(Entry? entry)
    {
        if (entry is null) return null;
        var age = dateTimeProvider.UtcNow - entry.At;
        return age >= TimeSpan.Zero && age < HealthThresholds.ProbeCacheDuration ? entry : null;
    }
}
