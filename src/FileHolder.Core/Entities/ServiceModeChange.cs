namespace FileHolder.Core.Entities;

/// <summary>
/// One switch of the <see cref="ServiceMode"/>, kept as a log: the latest row is the current mode (none means
/// <see cref="ServiceMode.Normal"/>), and the rows before it say who changed it, when and why.
/// </summary>
public class ServiceModeChange
{
    public long Id { get; set; }
    public ServiceMode Mode { get; set; }

    /// <summary>Shown to visitors, e.g. "Uploads are paused while we look into abuse reports."</summary>
    public string? Message { get; set; }

    /// <summary>When the owner expects to switch back; shown to visitors. Informational: nothing switches back by itself.</summary>
    public DateTime? Until { get; set; }

    /// <summary>Why the mode changed. Only in the log and the admin endpoint, never shown to visitors.</summary>
    public string Reason { get; set; } = string.Empty;

    /// <summary>Who changed it, as they said: everyone with the admin token is the same caller to the API.</summary>
    public string? ChangedBy { get; set; }

    public DateTime ChangedAt { get; set; }
}
