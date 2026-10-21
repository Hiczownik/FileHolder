using System.Text.Json.Serialization;

namespace FileHolder.Core.Entities;

/// <summary>
/// What a recipient needs to open an encrypted bundle. The keys are derived in the browser, so the server can't
/// check that this matches what the uploader did; it only tells the download page how to unlock.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum KeyMode
{
    /// <summary>The key in the share link's fragment (<c>#k=…</c>) alone.</summary>
    LinkKey,

    /// <summary>The key in the share link's fragment and a passkey sent separately.</summary>
    LinkKeyAndPasskey
}
