using System.Diagnostics;
using OpenTelemetry.Trace;

namespace FileHolder.Api.Telemetry;

/// <summary>
/// Decides whether a new trace starts, at the configured ratio: at an incoming request or one of the API's own
/// (internal) spans, such as a purge batch. An outgoing call with no parent (a database query or storage request)
/// starts none, so the readiness checks' constant probes don't fill the trace store. Spans inside a trace follow
/// their parent (see <see cref="ParentBasedSampler"/>).
/// </summary>
public sealed class RequestRootSampler(double ratio) : Sampler
{
    private readonly TraceIdRatioBasedSampler _ratio = new(ratio);

    public override SamplingResult ShouldSample(in SamplingParameters samplingParameters) =>
        samplingParameters.Kind is ActivityKind.Server or ActivityKind.Internal
            ? _ratio.ShouldSample(samplingParameters)
            : new SamplingResult(SamplingDecision.Drop);
}
