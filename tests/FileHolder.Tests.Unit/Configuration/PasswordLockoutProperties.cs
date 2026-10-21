using FileHolder.Core.Configuration;
using FileHolder.Tests.Unit.Properties;
using FsCheck;
using FsCheck.Fluent;

namespace FileHolder.Tests.Unit.Configuration;

/// <summary>Rules the per-bundle lockout keeps for any count of wrong passwords, edges included.</summary>
public class PasswordLockoutProperties
{
    private static readonly Arbitrary<int> AttemptsArb = Gen.Frequency(
            (3, Gen.Choose(-10, 40)),
            (2, Gen.Elements(int.MinValue, int.MinValue + 1, -1, 0, PasswordLockout.FreeAttempts, PasswordLockout.FreeAttempts + 1, int.MaxValue - 1, int.MaxValue)),
            (3, Gen.Choose(int.MinValue, int.MaxValue)))
        .ToArbitrary();

    [FixedSeedProperty]
    public Property LockoutAfter_IsNothingWithinTheFreeAttempts_AndOtherwiseBetweenTheFirstLockoutAndTheCap() =>
        Prop.ForAll(AttemptsArb, attempts =>
        {
            var lockout = PasswordLockout.LockoutAfter(attempts);
            var expected = attempts <= PasswordLockout.FreeAttempts
                ? lockout is null
                : lockout >= PasswordLockout.FirstLockout && lockout <= PasswordLockout.MaxLockout;
            return expected.Label($"LockoutAfter({attempts}) = {lockout?.ToString() ?? "none"}");
        });

    [FixedSeedProperty]
    public Property LockoutAfter_NeverShrinksAsWrongPasswordsAddUp() =>
        Prop.ForAll(AttemptsArb, AttemptsArb, (a, b) =>
        {
            var (fewer, more) = a <= b ? (a, b) : (b, a);
            var shorter = PasswordLockout.LockoutAfter(fewer) ?? TimeSpan.Zero;
            var longer = PasswordLockout.LockoutAfter(more) ?? TimeSpan.Zero;
            return (shorter <= longer).Label($"LockoutAfter({fewer}) = {shorter}, LockoutAfter({more}) = {longer}");
        });
}
