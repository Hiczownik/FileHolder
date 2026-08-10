namespace FileHolder.Core.Interfaces;

public interface IDateTimeProvider
{
    DateTime UtcNow { get; }
}