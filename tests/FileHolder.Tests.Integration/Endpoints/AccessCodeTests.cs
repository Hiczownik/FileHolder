using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FileHolder.Core.Configuration;
using FileHolder.Core.Dtos;
using FileHolder.Infrastructure.Data;
using FileHolder.Tests.Integration.Fixtures;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using static FileHolder.Tests.Integration.Fixtures.AccessCodesFactory;

namespace FileHolder.Tests.Integration.Endpoints;

/// <summary>
/// Tiered access codes (#169): small limits without a code, the full ones with a valid code, codes managed on the
/// admin port, counted per code, and never linked to a bundle.
/// </summary>
public class AccessCodeTests(AccessCodesFactory factory) : IClassFixture<AccessCodesFactory>
{
    private readonly HttpClient _client = factory.CreateClient();
    private readonly HttpClient _admin = factory.CreateAdminClient();
    private static int _labels;

    /// <summary>A new code under a fresh label (codes are shared by the class's tests).</summary>
    private async Task<AccessCodeCreatedDto> CreateCodeAsync(object? body = null)
    {
        var label = $"t{Interlocked.Increment(ref _labels)}";
        var response = await _admin.PostAsJsonAsync("/admin/access-codes", body ?? new { label });
        response.StatusCode.Should().Be(HttpStatusCode.Created);
        return (await response.Content.ReadFromJsonAsync<AccessCodeCreatedDto>())!;
    }

    private Task<HttpResponseMessage> PresignAsync(long sizeBytes, int hours, string? code = null) =>
        _client.PostAsJsonAsync("/api/v1/files/presign", new CreatePresignedUrlRequestDto(
            "Tier", [new FileItemInputDto("tier.pdf", "application/pdf", sizeBytes)], hours, 5, null, AccessCode: code));

    private async Task<string> UploadAsync(long sizeBytes, int hours, string? code, int? confirmHours = null)
    {
        var presign = await PresignAsync(sizeBytes, hours, code);
        presign.StatusCode.Should().Be(HttpStatusCode.OK, await presign.Content.ReadAsStringAsync());
        var body = (await presign.Content.ReadFromJsonAsync<PresignedUrlResponseDto>())!;
        foreach (var item in body.Items) factory.SeedS3Object(item.StorageKey, sizeBytes);
        var confirm = await _client.PostAsJsonAsync("/api/v1/files/confirm", new ConfirmUploadRequestDto(
            body.UploadToken, "Tier", [new ConfirmedFileItemDto(body.Items[0].StorageKey, "tier.pdf", "application/pdf", sizeBytes)],
            confirmHours ?? hours, 5, null));
        return $"{(int)confirm.StatusCode}:{await confirm.Content.ReadAsStringAsync()}";
    }

    private async Task<AccessCodeDto> ListedAsync(string label) =>
        (await _admin.GetFromJsonAsync<List<AccessCodeDto>>("/admin/access-codes"))!.Single(c => c.Label == label);

    private static async Task<string> DetailOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("detail").GetString()!;

    private static async Task<string> ErrorsOf(HttpResponseMessage response) =>
        (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("errors").ToString();

    [Fact]
    public async Task TheLimits_AreThoseWithoutACode_AndSayCodesExist()
    {
        var limits = await _client.GetFromJsonAsync<UploadLimitsResponseDto>("/api/v1/files/limits");

        limits.Should().Be(new UploadLimitsResponseDto(WithoutCodeBytes, 50, 1, WithoutCodeHours, AccessCodesEnabled: true, LongestExpiryHours: WithCodeHours));
    }

    [Fact]
    public async Task WithoutACode_TheSmallLimitsApply_AndTheRefusalMentionsCodes()
    {
        (await PresignAsync(WithoutCodeBytes, WithoutCodeHours)).StatusCode.Should().Be(HttpStatusCode.OK);

        var tooBig = await PresignAsync(WithoutCodeBytes + 1, WithoutCodeHours);
        tooBig.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ErrorsOf(tooBig)).Should().Contain("Without an access code, a bundle can be at most 10 MB in total. An access code allows more.");

        var tooLong = await PresignAsync(1024, WithoutCodeHours + 1);
        tooLong.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ErrorsOf(tooLong)).Should().Contain("Without an access code, a bundle can live at most 1 hour.");
    }

    [Fact]
    public async Task WithAValidCode_TheFullLimitsApply_AndTheBundleIsCounted()
    {
        var code = await CreateCodeAsync();

        (await UploadAsync(WithCodeBytes, WithCodeHours, code.Code)).Should().StartWith("200:");
        (await PresignAsync(WithCodeBytes + 1, WithCodeHours, code.Code)).StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var listed = await ListedAsync(code.Label);
        listed.BundleCount.Should().Be(1);
        listed.BytesUploaded.Should().Be(WithCodeBytes);
        listed.FirstUsedAt.Should().NotBeNull();
        listed.LastUsedAt.Should().NotBeNull();
        listed.Status.Should().Be("active");
    }

    [Fact]
    public async Task NoBundle_StoresWhichCodeItCameWith()
    {
        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var columns = await db.Database.SqlQueryRaw<string>(
            "SELECT column_name AS \"Value\" FROM information_schema.columns WHERE table_name IN ('FileGroups', 'SharedFiles')").ToListAsync();

        columns.Should().NotContain(c => c.Contains("Access", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task ARetypedCode_StillWorks()
    {
        var code = await CreateCodeAsync();
        var retyped = $"  {code.Code.ToLowerInvariant().Replace("-", " - ", StringComparison.Ordinal)}  ";

        (await PresignAsync(WithCodeBytes, WithCodeHours, retyped)).StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    [InlineData("a01-0000-0000-0000")]
    [InlineData("nonsense")]
    public async Task AnUnknownCode_IsRefusedClearly_NotSilentlyDowngraded(string code)
    {
        var response = await PresignAsync(1024, WithoutCodeHours, code);

        response.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await DetailOf(response)).Should().Be(AccessCodeRules.InvalidCodeMessage);
    }

    [Fact]
    public async Task TheCheck_GivesAValidCodesLimits_AndTheSameRefusalForAnyInvalidOne()
    {
        var code = await CreateCodeAsync();

        var valid = await _client.PostAsJsonAsync("/api/v1/files/access-codes/check", new AccessCodeCheckRequestDto(code.Code));
        (await valid.Content.ReadFromJsonAsync<UploadLimitsResponseDto>()).Should()
            .Be(new UploadLimitsResponseDto(WithCodeBytes, 50, 1, WithCodeHours, AccessCodesEnabled: true, LongestExpiryHours: WithCodeHours));

        var unknown = await _client.PostAsJsonAsync("/api/v1/files/access-codes/check", new AccessCodeCheckRequestDto("a01-0000-0000-0000"));
        await _admin.PostAsync($"/admin/access-codes/{code.Label}/revoke", null);
        var revoked = await _client.PostAsJsonAsync("/api/v1/files/access-codes/check", new AccessCodeCheckRequestDto(code.Code));

        foreach (var refused in new[] { unknown, revoked })
        {
            refused.StatusCode.Should().Be(HttpStatusCode.BadRequest);
            (await DetailOf(refused)).Should().Be(AccessCodeRules.InvalidCodeMessage);
        }
    }

    [Fact]
    public async Task ACode_ExpiresAfter30Days_AndExtendingRevivesIt()
    {
        var code = await CreateCodeAsync();
        code.ExpiresAt.Should().BeCloseTo(factory.Clock.UtcNow + AccessCodeRules.DefaultLifetime, TimeSpan.FromSeconds(5));

        factory.Clock.Advance(AccessCodeRules.DefaultLifetime + TimeSpan.FromMinutes(1));
        (await PresignAsync(1024, WithCodeHours, code.Code)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ListedAsync(code.Label)).Status.Should().Be("expired");

        (await _admin.PostAsJsonAsync($"/admin/access-codes/{code.Label}/extend", new ExtendAccessCodeRequestDto(Days: 14)))
            .StatusCode.Should().Be(HttpStatusCode.OK);
        (await PresignAsync(1024, WithCodeHours, code.Code)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await ListedAsync(code.Label)).ExpiresAt.Should().BeCloseTo(factory.Clock.UtcNow.AddDays(14), TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task ACodeWithoutExpiry_KeepsWorking_UntilRevoked()
    {
        var code = await CreateCodeAsync(new { label = $"n{Interlocked.Increment(ref _labels)}", noExpiry = true });
        code.ExpiresAt.Should().BeNull();

        factory.Clock.Advance(TimeSpan.FromDays(400));
        (await PresignAsync(1024, WithCodeHours, code.Code)).StatusCode.Should().Be(HttpStatusCode.OK);

        (await _admin.PostAsync($"/admin/access-codes/{code.Label}/revoke", null)).StatusCode.Should().Be(HttpStatusCode.OK);
        (await PresignAsync(1024, WithCodeHours, code.Code)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await ListedAsync(code.Label)).Status.Should().Be("revoked");
    }

    [Fact]
    public async Task Confirm_CantAskForMoreTimeThanPresignAllowed()
    {
        (await UploadAsync(1024, WithoutCodeHours, code: null, confirmHours: WithCodeHours)).Should()
            .StartWith("400:").And.Contain("at most 1 hour");
    }

    [Theory]
    [InlineData("Acme")]
    [InlineData("acme corp")]
    [InlineData("01")]
    public async Task Labels_MustBeNeutralNames(string label)
    {
        (await _admin.PostAsJsonAsync("/admin/access-codes", new { label })).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ALabel_CanOnlyBeUsedOnce()
    {
        var code = await CreateCodeAsync();

        (await _admin.PostAsJsonAsync("/admin/access-codes", new { label = code.Label })).StatusCode.Should().Be(HttpStatusCode.Conflict);
    }

    [Fact]
    public async Task Codes_AreManagedOnTheAdminPortOnly()
    {
        (await _client.GetAsync("/admin/access-codes")).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
        (await _client.PostAsJsonAsync("/admin/access-codes", new { label = "x1" })).StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }

    [Theory]
    [InlineData("10485760", null)]
    [InlineData("314572800", "1")]
    [InlineData("10485760", "48")]
    public void Startup_RefusesWithoutCodeSettingsThatAreHalfSetOrLargerThanACodes(string bytes, string? hours)
    {
        using var misconfigured = factory.WithWebHostBuilder(builder => builder.ConfigureAppConfiguration(config =>
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["UploadLimits:WithoutCodeMaxBundleSizeBytes"] = bytes,
                ["UploadLimits:WithoutCodeMaxExpiryHours"] = hours,
            })));

        var start = () => misconfigured.CreateClient();

        start.Should().Throw<OptionsValidationException>().WithMessage("*must be set together*");
    }
}
