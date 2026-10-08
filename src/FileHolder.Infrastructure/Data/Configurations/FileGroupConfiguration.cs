using FileHolder.Core.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace FileHolder.Infrastructure.Data.Configurations;

public class FileGroupConfiguration : IEntityTypeConfiguration<FileGroup>
{
    public void Configure(EntityTypeBuilder<FileGroup> builder)
    {
        builder.ToTable("FileGroups");

        builder.HasKey(g => g.Id);

        builder.Property(g => g.ShareToken)
            .IsRequired()
            .HasMaxLength(32);

        builder.Property(g => g.Title)
            .HasMaxLength(255);

        builder.Property(g => g.PasswordHash)
            .HasMaxLength(255);

        builder.Property(g => g.IsEncrypted)
            .IsRequired()
            .HasDefaultValue(false);

        builder.Property(g => g.EncryptedManifest)
            .HasColumnType("text")
            .IsRequired(false);

        builder.HasIndex(g => g.ShareToken)
            .IsUnique()
            .HasFilter("\"IsDeleted\" = FALSE");

        builder.HasIndex(g => new { g.ExpiresAt, g.DownloadCount, g.MaxDownloads })
            .HasFilter("\"IsDeleted\" = FALSE");

        builder.HasMany(g => g.Files)
            .WithOne(f => f.FileGroup)
            .HasForeignKey(f => f.FileGroupId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}