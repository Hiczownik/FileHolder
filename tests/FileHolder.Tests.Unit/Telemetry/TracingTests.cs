using System.Diagnostics;
using FileHolder.Api.Telemetry;
using FileHolder.Infrastructure.Diagnostics;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using OpenTelemetry.Trace;

namespace FileHolder.Tests.Unit.Telemetry;

public sealed class TracingTests : IDisposable
{
    private const string Guid = "0123456789abcdef0123456789abcdef";

    private readonly ActivitySource _source = new("FileHolder.Tests.Unit.Tracing");
    private readonly ActivityListener _listener;

    public TracingTests()
    {
        _listener = new ActivityListener
        {
            ShouldListenTo = source => source == _source || source == FileHolderTracing.Source,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded
        };
        ActivitySource.AddActivityListener(_listener);
    }

    public void Dispose()
    {
        _listener.Dispose();
        _source.Dispose();
    }

    private static TraceRedactionProcessor Processor(bool recordClientAddress = false) =>
        new(Options.Create(new TracingOptions { RecordClientAddress = recordClientAddress }));

    private Activity Span(ActivityKind kind, params (string Key, object? Value)[] tags)
    {
        var activity = _source.StartActivity("span", kind)!;
        foreach (var (key, value) in tags)
        {
            activity.SetTag(key, value);
        }

        activity.Stop();
        return activity;
    }

    #region Redaction

    [Fact]
    public void RequestPath_IsReplacedByItsRouteTemplate()
    {
        var span = Span(ActivityKind.Server,
            ("url.path", "/api/v1/files/Ab3xYz9Q/unlock"),
            ("http.route", "/api/v1/files/{shareToken}/unlock"));

        Processor().OnEnd(span);

        span.GetTagItem("url.path").Should().Be("/api/v1/files/{shareToken}/unlock");
    }

    [Fact]
    public void RequestPath_IsDropped_WhenNoRouteMatched()
    {
        var span = Span(ActivityKind.Server, ("url.path", "/api/v1/files/Ab3xYz9Q/nothing-here"));

        Processor().OnEnd(span);

        span.GetTagItem("url.path").Should().BeNull();
    }

    [Fact]
    public void QueryStrings_AreDropped()
    {
        var span = Span(ActivityKind.Server, ("url.query", "?session=6f1c"));

        Processor().OnEnd(span);

        span.GetTagItem("url.query").Should().BeNull();
    }

    [Theory]
    // a presigned URL: the signature and credential are in the query string
    [InlineData(
        $"http://silo:9000/fileholder-bucket/uploads/{Guid}_holiday%20photo.jpg?X-Amz-Credential=minioadmin%2F20261023&X-Amz-Signature=abc123",
        $"http://silo:9000/fileholder-bucket/uploads/{Guid}_[name]")]
    // the SDK percent-encodes the key's underscore in some requests
    [InlineData(
        $"http://silo:9000/fileholder-bucket/uploads/{Guid}%5Fholiday.jpg?partNumber=2&uploadId=xyz",
        $"http://silo:9000/fileholder-bucket/uploads/{Guid}_[name]")]
    // an encrypted bundle's key has no name to hide
    [InlineData(
        $"http://silo:9000/fileholder-bucket/uploads/{Guid}.enc",
        $"http://silo:9000/fileholder-bucket/uploads/{Guid}.enc")]
    [InlineData("http://silo:9000/fileholder-bucket?lifecycle", "http://silo:9000/fileholder-bucket")]
    [InlineData("http://silo:9000/fileholder-bucket#fragment", "http://silo:9000/fileholder-bucket")]
    public void StorageUrls_KeepTheKeysGuid_ButNotItsFileNameOrQueryString(string url, string expected)
    {
        var span = Span(ActivityKind.Client, ("url.full", url));

        Processor().OnEnd(span);

        span.GetTagItem("url.full").Should().Be(expected);
    }

    [Fact]
    public void ClientAddresses_AreDroppedFromRequests_ByDefault()
    {
        var span = Span(ActivityKind.Server,
            ("client.address", "203.0.113.7"), ("client.port", 51234),
            ("network.peer.address", "203.0.113.7"), ("network.peer.port", 51234));

        Processor().OnEnd(span);

        span.TagObjects.Should().BeEmpty();
    }

    [Fact]
    public void ClientAddresses_AreKept_WhenRecordClientAddressIsSet()
    {
        var span = Span(ActivityKind.Server, ("client.address", "203.0.113.7"));

        Processor(recordClientAddress: true).OnEnd(span);

        span.GetTagItem("client.address").Should().Be("203.0.113.7");
    }

    [Fact]
    public void StorageServerAddresses_AreKept()
    {
        var span = Span(ActivityKind.Client, ("server.address", "silo"), ("network.peer.address", "172.18.0.3"));

        Processor().OnEnd(span);

        span.GetTagItem("server.address").Should().Be("silo");
        span.GetTagItem("network.peer.address").Should().Be("172.18.0.3");
    }

    [Fact]
    public void DatabaseConnectionStrings_AreDropped()
    {
        var span = Span(ActivityKind.Client, ("db.connection_string", "Host=postgres;Username=fileholder_user"));

        Processor().OnEnd(span);

        span.GetTagItem("db.connection_string").Should().BeNull();
    }

    #endregion

    #region Sampling

    private static SamplingDecision Decide(ActivityKind kind, double ratio = 1.0, ActivityContext parent = default) =>
        new ParentBasedSampler(new RequestRootSampler(ratio))
            .ShouldSample(new SamplingParameters(parent, ActivityTraceId.CreateRandom(), "span", kind))
            .Decision;

    [Theory]
    [InlineData(ActivityKind.Server)]
    [InlineData(ActivityKind.Internal)]
    public void Traces_StartAtRequestsAndOwnSpans(ActivityKind kind) =>
        Decide(kind).Should().Be(SamplingDecision.RecordAndSample);

    [Fact]
    public void OutgoingCallsWithNoParent_StartNoTrace() =>
        Decide(ActivityKind.Client).Should().Be(SamplingDecision.Drop);

    [Fact]
    public void OutgoingCalls_InsideARecordedTrace_AreRecorded()
    {
        var parent = new ActivityContext(
            ActivityTraceId.CreateRandom(), ActivitySpanId.CreateRandom(), ActivityTraceFlags.Recorded);

        Decide(ActivityKind.Client, parent: parent).Should().Be(SamplingDecision.RecordAndSample);
    }

    [Fact]
    public void ARatioOfZero_StartsNoTrace() =>
        Decide(ActivityKind.Server, ratio: 0).Should().Be(SamplingDecision.Drop);

    #endregion

    #region Own spans

    [Fact]
    public void Steps_AreOnlyRecordedInsideATrace()
    {
        FileHolderTracing.StartStep("storage.get_object_size").Should().BeNull("a health check's call starts no trace");

        using var request = _source.StartActivity("request", ActivityKind.Server)!;
        using var step = FileHolderTracing.StartStep("storage.get_object_size");

        step.Should().NotBeNull();
        step!.ParentSpanId.Should().Be(request.SpanId);
        step.Kind.Should().Be(ActivityKind.Internal);
    }

    [Fact]
    public void Roots_StartATraceOfTheirOwn()
    {
        using var run = FileHolderTracing.StartRoot("purge.run");

        run.Should().NotBeNull();
        run!.ParentSpanId.Should().Be(default(ActivitySpanId));
        run.Kind.Should().Be(ActivityKind.Internal, "the sampler starts traces at internal spans, not at outgoing calls");
    }

    [Fact]
    public async Task FailedSteps_RecordTheExceptionType_NotItsMessage()
    {
        using var request = _source.StartActivity("request", ActivityKind.Server)!;
        Activity? step = null;

        var work = () => FileHolderTracing.StepAsync("confirm.check_sizes", activity =>
        {
            step = activity;
            throw new InvalidOperationException("File size mismatch for holiday.jpg");
        });

        await work.Should().ThrowAsync<InvalidOperationException>();
        step!.Status.Should().Be(ActivityStatusCode.Error);
        step.StatusDescription.Should().BeNull();
        step.GetTagItem("error.type").Should().Be("System.InvalidOperationException");
        step.IsStopped.Should().BeTrue();
    }

    [Theory]
    [InlineData($"uploads/{Guid}_holiday photo.jpg", $"uploads/{Guid}_[name]")]
    [InlineData($"uploads/{Guid}.enc", $"uploads/{Guid}.enc")]
    [InlineData("files/0123456789abcdef0123456789abcdef", "files/0123456789abcdef0123456789abcdef")]
    public void StorageKeys_KeepOnlyTheirGuid(string key, string expected) =>
        FileHolderTracing.RedactStorageKeys(key).Should().Be(expected);

    #endregion

    #region Logs

    private sealed class CollectingSink : Serilog.Core.ILogEventSink
    {
        public List<Serilog.Events.LogEvent> Events { get; } = [];

        public void Emit(Serilog.Events.LogEvent logEvent) => Events.Add(logEvent);
    }

    private static Serilog.Events.LogEvent Log()
    {
        var sink = new CollectingSink();
        using var logger = new Serilog.LoggerConfiguration()
            .Enrich.With<TraceContextEnricher>()
            .WriteTo.Sink(sink)
            .CreateLogger();
        logger.Information("Bundle confirmed");
        return sink.Events.Single();
    }

    [Fact]
    public void LogLines_InsideARecordedTrace_NameIt()
    {
        using var span = _source.StartActivity("request", ActivityKind.Server)!;

        var line = Log();

        line.Properties[TraceContextEnricher.PropertyName].ToString("l", null)
            .Should().Be($" trace={span.TraceId} span={span.SpanId}");
    }

    [Fact]
    public void LogLines_OutsideATrace_OrInOneNotRecorded_NameNone()
    {
        Log().Properties.Should().NotContainKey(TraceContextEnricher.PropertyName);

        using var unrecorded = new Activity("request").Start();
        Log().Properties.Should().NotContainKey(TraceContextEnricher.PropertyName);
    }

    #endregion

    #region Export

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("  ", false)]
    [InlineData("http://tempo:4317", true)]
    public void Traces_AreOnlyExported_WhenAnOtlpEndpointIsSet(string? endpoint, bool exported)
    {
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { [TracingRegistration.OtlpEndpointSetting] = endpoint })
            .Build();

        TracingRegistration.ShouldExport(configuration).Should().Be(exported);
    }

    #endregion
}
