using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class PendingUploadConfiguration : IEntityTypeConfiguration<PendingUpload>
{
    public void Configure(EntityTypeBuilder<PendingUpload> builder)
    {
        builder.ToTable("PendingUploads");

        builder.HasKey(p => p.Id);

        builder.Property(p => p.UploadToken)
            .IsRequired()
            .HasMaxLength(64);

        builder.Property(p => p.StorageKey)
            .IsRequired()
            .HasMaxLength(512);

        builder.Property(p => p.FileName)
            .IsRequired()
            .HasMaxLength(255);

        builder.Property(p => p.ContentType)
            .IsRequired()
            .HasMaxLength(128);

        builder.Property(p => p.CreatedAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        builder.Property(p => p.ExpiresAt)
            .HasColumnType("timestamp with time zone")
            .IsRequired();

        builder.Property(p => p.ClaimedUntil)
            .HasColumnType("timestamp with time zone");

        builder.HasIndex(p => p.UploadToken);

        builder.HasIndex(p => p.StorageKey)
            .IsUnique();

        builder.HasIndex(p => p.ExpiresAt);
    }
}
