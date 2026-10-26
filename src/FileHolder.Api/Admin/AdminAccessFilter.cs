using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace FileHolder.Api.Admin;

/// <summary>
/// Admin endpoints answer only on the admin port and only with the admin token. Anywhere else they don't exist (404),
/// so the public port gives nothing away; a wrong or missing token on the admin port gets 401.
/// The port is the one the connection arrived on, not the Host header, which clients can set to anything.
/// </summary>
public sealed class AdminAccessFilter(IOptions<AdminOptions> options) : IEndpointFilter
{
    private const string BearerPrefix = "Bearer ";

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var admin = options.Value;
        var http = context.HttpContext;

        if (string.IsNullOrEmpty(admin.Token) || http.Connection.LocalPort != admin.Port)
        {
            return TypedResults.NotFound();
        }

        string header = http.Request.Headers.Authorization.ToString();
        if (!header.StartsWith(BearerPrefix, StringComparison.Ordinal) || !TokensMatch(header[BearerPrefix.Length..], admin.Token))
        {
            return TypedResults.Unauthorized();
        }

        return await next(context);
    }

    /// <summary>Compares hashes, so the time taken says nothing about the token's length or how much of it matched.</summary>
    private static bool TokensMatch(string given, string expected) =>
        CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(given)),
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
}
