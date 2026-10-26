using System.ComponentModel.DataAnnotations;

namespace FileHolder.Api.Admin;

/// <summary>
/// The owner's admin endpoints (/admin/...): served only on <see cref="Port"/>, which compose binds to the host's
/// loopback and no proxy forwards, and only with <see cref="Token"/> as a bearer token. Without a token they're off.
/// </summary>
public class AdminOptions
{
    public const string SectionName = "Admin";

    public int Port { get; set; } = 9465;

    /// <summary>A long random secret (README, Quick Start generates one). Unset, every admin request gets 404.</summary>
    // Not [MinLength]: that refuses an empty value, which is how compose passes a blank ADMIN_TOKEN, meaning "off".
    [RegularExpression("^.{32,}$", ErrorMessage = "Admin:Token must be at least 32 characters (e.g. openssl rand -hex 32), or unset to turn the admin endpoints off.")]
    public string? Token { get; set; }
}
