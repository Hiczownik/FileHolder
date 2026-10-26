using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class AccessCodeConfiguration : IEntityTypeConfiguration<AccessCode>
{
    public const int MaxLabelLength = 20;

    public void Configure(EntityTypeBuilder<AccessCode> builder)
    {
        builder.ToTable("AccessCodes");

        builder.HasKey(c => c.Id);

        builder.Property(c => c.Label)
            .IsRequired()
            .HasMaxLength(MaxLabelLength);

        // SHA-256 as base64: 44 characters.
        builder.Property(c => c.CodeHash)
            .IsRequired()
            .HasMaxLength(64);

        builder.Property(c => c.CreatedAt).HasColumnType("timestamp with time zone").IsRequired();
        builder.Property(c => c.ExpiresAt).HasColumnType("timestamp with time zone");
        builder.Property(c => c.RevokedAt).HasColumnType("timestamp with time zone");
        builder.Property(c => c.FirstUsedAt).HasColumnType("timestamp with time zone");
        builder.Property(c => c.LastUsedAt).HasColumnType("timestamp with time zone");

        builder.HasIndex(c => c.Label).IsUnique();
        builder.HasIndex(c => c.CodeHash).IsUnique();
    }
}
