using System.Globalization;
using FsCheck.Xunit;

namespace FileHolder.Tests.Unit.Properties;

/// <summary>
/// A property test run on a fixed seed, so every CI run tries the same inputs and a failure reproduces exactly.
/// The nightly run sets FSCHECK_RANDOM=1 for fresh inputs and FSCHECK_MAX_TEST for many more of them; a failure
/// there prints its "(seed,gamma)", and FSCHECK_REPLAY set to that (with the same FSCHECK_MAX_TEST) reruns it.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class FixedSeedPropertyAttribute : PropertyAttribute
{
    // FsCheck's "(seed,gamma)"; any fixed pair will do, as long as it stays the same.
    private const string FixedSeed = "(1734120533,296144285)";
    private const int DefaultMaxTest = 500;

    public FixedSeedPropertyAttribute()
    {
        var replay = Environment.GetEnvironmentVariable("FSCHECK_REPLAY");
        if (!string.IsNullOrWhiteSpace(replay))
        {
            Replay = replay;
        }
        else if (Environment.GetEnvironmentVariable("FSCHECK_RANDOM") != "1")
        {
            Replay = FixedSeed;
        }

        MaxTest = int.TryParse(Environment.GetEnvironmentVariable("FSCHECK_MAX_TEST"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var maxTest)
            ? maxTest
            : DefaultMaxTest;
    }
}
