using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using OpenTelemetry;

namespace FileHolder.Api.Telemetry;

/// <summary>
/// Removes what must never leave the API in a trace, from every span before any exporter sees it:
/// <list type="bullet">
/// <item>share tokens, which open a bundle without a password: a request's path is replaced by its route template
/// (<c>/api/v1/files/{shareToken}/unlock</c>), and dropped when no route matched;</item>
/// <item>query strings: presigned storage URLs carry their signature there, and download-all its session id;</item>
/// <item>file names in storage keys (<c>uploads/{guid}_{name}</c>): only the GUID is kept;</item>
/// <item>the caller's address, unless <see cref="TracingOptions.RecordClientAddress"/> is set;</item>
/// <item>the database connection string.</item>
/// </list>
/// Request and response bodies (passwords, kAuth, keys, manifests) are never recorded in the first place.
/// </summary>
public sealed partial class TraceRedactionProcessor(IOptions<TracingOptions> options) : BaseProcessor<Activity>
{
    public const string RedactedName = "[name]";

    public override void OnEnd(Activity data)
    {
        if (data.GetTagItem("url.path") is not null)
        {
            data.SetTag("url.path", data.GetTagItem("http.route") as string);
        }

        data.SetTag("url.query", null);

        if (data.GetTagItem("url.full") is string fullUrl)
        {
            data.SetTag("url.full", RedactUrl(fullUrl));
        }

        if (!options.Value.RecordClientAddress && data.Kind == ActivityKind.Server)
        {
            data.SetTag("client.address", null);
            data.SetTag("client.port", null);
            // On a request span this is whoever connected: the client, or the proxy in front of it.
            data.SetTag("network.peer.address", null);
            data.SetTag("network.peer.port", null);
        }

        data.SetTag("db.connection_string", null);
    }

    /// <summary>A URL without its query string, fragment or the file names in its storage keys.</summary>
    public static string RedactUrl(string url)
    {
        var end = url.IndexOfAny(['?', '#']);
        var withoutQuery = end >= 0 ? url[..end] : url;
        return StorageKeyFileName().Replace(withoutQuery, "$1_" + RedactedName);
    }

    // The name after a storage key's GUID, also when the underscore arrives percent-encoded.
    [GeneratedRegex("(uploads/[0-9a-fA-F]{32})(?:_|%5[fF])[^/]*")]
    private static partial Regex StorageKeyFileName();
}
