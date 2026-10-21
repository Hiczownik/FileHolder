using System.Text.Json;
using FileHolder.Api.ExceptionHandling;
using FileHolder.Core.Exceptions;
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FileHolder.Tests.Integration.ExceptionHandling;

public class GlobalExceptionHandlerTests
{
    private static GlobalExceptionHandler CreateHandler(string environmentName = "Production")
    {
        var environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns(environmentName);
        return new GlobalExceptionHandler(NullLogger<GlobalExceptionHandler>.Instance, environment);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Path = "/api/v1/files/confirm";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static async Task<(int Status, JsonElement Body)> HandleAsync(Exception exception, string environmentName = "Production")
    {
        var context = CreateContext();

        var handled = await CreateHandler(environmentName).TryHandleAsync(context, exception, CancellationToken.None);

        handled.Should().BeTrue();
        context.Response.Body.Position = 0;
        var body = await JsonDocument.ParseAsync(context.Response.Body);
        return (context.Response.StatusCode, body.RootElement);
    }

    [Fact]
    public async Task ClientErrors_KeepTheirStatusAndMessage()
    {
        var (status, body) = await HandleAsync(new InvalidRequestException("File size mismatch for a.pdf"));
        status.Should().Be(StatusCodes.Status400BadRequest);
        body.GetProperty("detail").GetString().Should().Be("File size mismatch for a.pdf");

        (status, body) = await HandleAsync(new ResourceNotFoundException("Upload session was not found."));
        status.Should().Be(StatusCodes.Status404NotFound);
        body.GetProperty("detail").GetString().Should().Be("Upload session was not found.");
    }

    [Theory]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(ArgumentException))]
    [InlineData(typeof(KeyNotFoundException))]
    [InlineData(typeof(NullReferenceException))]
    public async Task InternalExceptions_Become500_WithoutLeakingTheirMessage(Type exceptionType)
    {
        var exception = (Exception)Activator.CreateInstance(exceptionType, "Invalid non-ASCII character in header: secret internals")!;

        var (status, body) = await HandleAsync(exception);

        status.Should().Be(StatusCodes.Status500InternalServerError);
        body.GetRawText().Should().NotContain("secret internals");
    }

    [Fact]
    public async Task UnreadableBody_Returns400_NotA500()
    {
        var exception = new BadHttpRequestException(
            "Failed to read parameter \"CreatePresignedUrlRequestDto dto\" from the request body as JSON.",
            StatusCodes.Status400BadRequest);

        var (status, body) = await HandleAsync(exception);

        status.Should().Be(StatusCodes.Status400BadRequest);
        body.GetRawText().Should().NotContain("CreatePresignedUrlRequestDto");
    }

    [Fact]
    public async Task Development_ShowsTheInternalMessage_ForServerErrors()
    {
        var (_, body) = await HandleAsync(new InvalidOperationException("internal detail"), "Development");

        body.GetProperty("detail").GetString().Should().Be("internal detail");
    }

    [Fact]
    public async Task ClientDisconnect_WritesNothing()
    {
        var context = CreateContext();
        using var cts = new CancellationTokenSource();
        context.RequestAborted = cts.Token;
        await cts.CancelAsync();

        var handled = await CreateHandler().TryHandleAsync(context, new OperationCanceledException(cts.Token), CancellationToken.None);

        handled.Should().BeTrue();
        context.Response.Body.Length.Should().Be(0);
    }

    [Fact]
    public async Task FailureAfterTheResponseStarted_AbortsTheConnection_InsteadOfAppendingJson()
    {
        var context = CreateContext();
        var lifetime = new TrackingLifetimeFeature();
        context.Features.Set<IHttpResponseFeature>(new StartedResponseFeature());
        context.Features.Set<IHttpRequestLifetimeFeature>(lifetime);

        var handled = await CreateHandler().TryHandleAsync(context, new IOException("S3 stream reset"), CancellationToken.None);

        handled.Should().BeTrue();
        lifetime.Aborted.Should().BeTrue("a ZIP cut off midway must not look like a complete download");
        context.Response.Body.Length.Should().Be(0);
    }

    [Theory]
    [InlineData(typeof(InvalidRequestException))]
    [InlineData(typeof(InvalidOperationException))]
    public async Task Logs_NameTheRoute_NotTheShareToken_NorTheFileName(Type exceptionType)
    {
        var logger = new RecordingLogger();
        var environment = Substitute.For<IHostEnvironment>();
        environment.EnvironmentName.Returns("Production");
        var handler = new GlobalExceptionHandler(logger, environment);

        var context = CreateContext();
        context.Request.Path = "/api/v1/files/AbCd1234/unlock";
        context.SetEndpoint(new RouteEndpoint(
            _ => Task.CompletedTask, RoutePatternFactory.Parse("/api/v1/files/{shareToken}/unlock"), 0, null, null));
        var exception = (Exception)Activator.CreateInstance(exceptionType, "File size mismatch for passport.pdf")!;

        await handler.TryHandleAsync(context, exception, CancellationToken.None);

        var logged = logger.Entries.Where(e => e.Level >= LogLevel.Information).ToList();
        logged.Should().NotBeEmpty();
        logged.Should().AllSatisfy(e =>
        {
            e.Message.Should().Contain("/api/v1/files/{shareToken}/unlock");
            e.Message.Should().NotContain("AbCd1234");
            e.Message.Should().NotContain("passport.pdf");
        });
    }

    private sealed class RecordingLogger : ILogger<GlobalExceptionHandler>
    {
        public List<(LogLevel Level, string Message)> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        // The exception itself is left out: a 500's stack trace goes to the log on purpose, and its message is
        // whatever the failing code wrote.
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Entries.Add((logLevel, formatter(state, null)));
    }

    private sealed class StartedResponseFeature : HttpResponseFeature
    {
        public override bool HasStarted => true;
    }

    private sealed class TrackingLifetimeFeature : IHttpRequestLifetimeFeature
    {
        public bool Aborted { get; private set; }
        public CancellationToken RequestAborted { get; set; }
        public void Abort() => Aborted = true;
    }
}
