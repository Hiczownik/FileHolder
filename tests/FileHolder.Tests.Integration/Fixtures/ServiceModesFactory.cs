namespace FileHolder.Tests.Integration.Fixtures;

/// <summary>
/// The API with the admin endpoints on: a token, and the admin port set to the test server's port (0), standing in
/// for the internal admin port. A <see cref="HealthChecksFactory"/>, so tests can set the clock the mode's
/// <c>until</c> is judged by. Its own fixture (and database), since the mode applies to every request.
/// </summary>
public class ServiceModesFactory : HealthChecksFactory
{
    public const string AdminToken = "test-admin-token-0123456789abcdef0123456789";

    protected override IReadOnlyDictionary<string, string?> Settings => new Dictionary<string, string?>
    {
        ["Admin:Port"] = "0",
        ["Admin:Token"] = AdminToken,
    };

    /// <summary>A client that sends the admin token.</summary>
    public HttpClient CreateAdminClient()
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", AdminToken);
        return client;
    }
}
