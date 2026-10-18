using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class MultipartUploadSessionConfiguration : IEntityTypeConfiguration<MultipartUploadSession>
{
    public void Configure(EntityTypeBuilder<MultipartUploadSession> builder)
    {
        builder.ToTable("MultipartUploadSessions");

        builder.HasKey(s => s.Id);

        builder.Property(s => s.UploadToken)
            .IsRequired()
            .HasMaxLength(64);

        builder.Property(s => s.UploadId)
            .IsRequired()
            .HasMaxLength(256);

        builder.Property(s => s.StorageKey)
            .IsRequired()
            .HasMaxLength(512);

        builder.Property(s => s.FileName)
            .IsRequired()
            .HasMaxLength(255);

        builder.Property(s => s.ContentType)
            .IsRequired()
            .HasMaxLength(128);

        builder.Property(s => s.ExpiresAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        builder.Property(s => s.CreatedAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        // One upload token covers every file of a presign request, so it is not unique on its own.
        builder.HasIndex(s => new { s.UploadToken, s.UploadId })
            .IsUnique();

        builder.HasIndex(s => new { s.IsCompleted, s.IsAborted, s.ExpiresAt });
    }
}