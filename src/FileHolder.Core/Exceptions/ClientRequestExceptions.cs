namespace FileHolder.Core.Exceptions;

/// <summary>
/// The request is well-formed but not acceptable (HTTP 400). The message is shown to the client,
/// so it must describe the caller's mistake and never internal state.
/// </summary>
public class InvalidRequestException(string message) : Exception(message);

/// <summary>
/// The requested resource does not exist or is no longer available (HTTP 404). The message is shown to the client.
/// </summary>
public class ResourceNotFoundException(string message) : Exception(message);

/// <summary>
/// The request clashes with one already in progress, such as a second confirm of the same upload (HTTP 409).
/// The message is shown to the client.
/// </summary>
public class ConflictException(string message) : Exception(message);
