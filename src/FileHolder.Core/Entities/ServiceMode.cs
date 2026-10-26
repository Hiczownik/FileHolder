using System.Text.Json.Serialization;

namespace FileHolder.Core.Entities;

/// <summary>
/// How much of FileHolder is open, switched by the owner without a restart (the admin port, README *Maintenance
/// Modes*). Each mode closes more than the one before it; what each allows is in
/// <see cref="Configuration.ServiceModeRules"/>. The purge runs in every mode, so pausing never delays a deletion.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ServiceMode
{
    /// <summary>Everything works.</summary>
    Normal,

    /// <summary>No new uploads; uploads already started can finish, and downloads work.</summary>
    UploadsPaused,

    /// <summary>Bundles can be viewed and downloads already started can finish; nothing new starts.</summary>
    ReadOnly,

    /// <summary>Nothing but the status: the UI shows a page saying FileHolder is closed.</summary>
    Closed
}
