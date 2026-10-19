using FileHolder.Core.Configuration;
using FluentAssertions;

namespace FileHolder.Tests.Unit.Configuration;

public class EncryptedStreamFormatTests
{
    private const long Chunk = 4L * 1024 * 1024;

    // Same cases as encryptedSize in the UI's streamCipher tests: the two must agree byte for byte,
    // or the server would reject (or mis-size the parts of) every encrypted upload.
    [Theory]
    [InlineData(0, 16)]
    [InlineData(1, 17)]
    [InlineData(Chunk, Chunk + 16)]
    [InlineData(Chunk + 1, Chunk + 1 + 32)]
    [InlineData(1024L * 1024 * 1024, 1024L * 1024 * 1024 + 256 * 16)]
    public void EncryptedSize_AddsOneTagPerChunk(long plaintextBytes, long expected)
    {
        EncryptedStreamFormat.EncryptedSize(plaintextBytes).Should().Be(expected);
    }

    [Fact]
    public void EncryptedChunkBytes_IsAChunkPlusItsTag()
    {
        EncryptedStreamFormat.EncryptedChunkBytes.Should().Be(Chunk + 16);
    }
}
