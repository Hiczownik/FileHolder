using System.Diagnostics.Metrics;

namespace FileHolder.Infrastructure.Services;

/// <summary>
/// Whether storage has confirmed the safety net's lifecycle rule, exposed as the metric
/// fileholder_storage_lifecycle_days: the days after which storage deletes any object, or 0 until the rule is in place.
/// </summary>
public sealed class StorageLifecycleStatus
{
    public const string MeterName = "FileHolder";
    public const string LifecycleDaysInstrument = "fileholder.storage.lifecycle_days";

    private int _confirmedExpiryDays;

    public StorageLifecycleStatus(IMeterFactory meterFactory)
    {
        var meter = meterFactory.Create(MeterName);
        meter.CreateObservableGauge(
            LifecycleDaysInstrument,
            () => ConfirmedExpiryDays,
            description: "Days after which storage deletes any object (the purge's safety net); 0 until storage has confirmed the rule.");
    }

    public int ConfirmedExpiryDays => Volatile.Read(ref _confirmedExpiryDays);

    public void Confirm(int expiryDays) => Volatile.Write(ref _confirmedExpiryDays, expiryDays);
}
