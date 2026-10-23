using System.Diagnostics;
using System.Text.RegularExpressions;

namespace FileHolder.Infrastructure.Diagnostics;

/// <summary>
/// The API's own spans: the steps inside a request (confirm, password checks, storage calls…) and the purge runs.
/// Their tags are counts, outcomes and GUIDs only: never share tokens, passwords, keys, titles or file names.
/// </summary>
public static partial class FileHolderTracing
{
    public const string SourceName = "FileHolder";

    public const string RedactedName = "[name]";

    public static readonly ActivitySource Source = new(SourceName);

    /// <summary>
    /// A span inside the current trace, or none outside one: a step called from a health check or a startup task
    /// doesn't start a trace of its own.
    /// </summary>
    public static Activity? StartStep(string name) =>
        Activity.Current is null ? null : Source.StartActivity(name);

    /// <summary>
    /// A span that starts a trace of its own, for background work outside any request, such as a purge run.
    /// (Inside a trace it would join it: there is no parent to leave out.)
    /// </summary>
    public static Activity? StartRoot(string name) => Source.StartActivity(name);

    public static async Task<T> StepAsync<T>(string name, Func<Activity?, Task<T>> work)
    {
        using var activity = StartStep(name);
        try
        {
            return await work(activity);
        }
        catch (Exception ex)
        {
            activity.RecordFailure(ex);
            throw;
        }
    }

    public static async Task StepAsync(string name, Func<Activity?, Task> work)
    {
        using var activity = StartStep(name);
        try
        {
            await work(activity);
        }
        catch (Exception ex)
        {
            activity.RecordFailure(ex);
            throw;
        }
    }

    /// <summary>
    /// Marks the span failed with the exception's type only: messages can name files and storage keys.
    /// </summary>
    public static void RecordFailure(this Activity? activity, Exception exception)
    {
        activity?.SetStatus(ActivityStatusCode.Error);
        activity?.SetTag("error.type", exception.GetType().FullName);
    }

    /// <summary>A storage key, or text holding some, with only the GUID of each: <c>uploads/{guid}_[name]</c>.</summary>
    public static string RedactStorageKeys(string text) =>
        StorageKeyFileName().Replace(text, "$1_" + RedactedName);

    // The name after a storage key's GUID, also when the underscore arrives percent-encoded in a URL.
    [GeneratedRegex("(uploads/[0-9a-fA-F]{32})(?:_|%5[fF])[^/?#]*")]
    private static partial Regex StorageKeyFileName();
}
