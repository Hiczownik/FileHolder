using System.Diagnostics.Metrics;
using FileHolder.Core.Configuration;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// Whether storage has confirmed the safety net's lifecycle rule, exposed as the metric
/// fileholder_storage_lifecycle_days: the days after which storage deletes any object, or 0 until the rule is in place.
/// When the rule is managed outside the app (<see cref="LifecycleRuleMode.External"/>) the API can't know, so the
/// metric reports nothing rather than a number that would look confirmed or failed.
/// </summary>
public sealed class StorageLifecycleStatus
{
    public const string MeterName = "FileHolder";
    public const string LifecycleDaysInstrument = "fileholder.storage.lifecycle_days";

    private int _confirmedExpiryDays;
    private int _isExternal;

    public StorageLifecycleStatus(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create(MeterName);
        meter.CreateObservableGauge(
            LifecycleDaysInstrument,
            () => IsExternal ? [] : new[] { new Measurement<int>(ConfirmedExpiryDays) },
            description: "Days after which storage deletes any object (the purge's safety net); 0 until storage has confirmed the rule.");
    }

    public int ConfirmedExpiryDays => Volatile.Read(ref _confirmedExpiryDays);

    /// <summary>The rule is managed outside the app, so storage is never asked to confirm it.</summary>
    public bool IsExternal => Volatile.Read(ref _isExternal) == 1;

    public void Confirm(int expiryDays) => Volatile.Write(ref _confirmedExpiryDays, expiryDays);

    public void MarkExternal() => Volatile.Write(ref _isExternal, 1);
}
