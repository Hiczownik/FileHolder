using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddEncryptedTitle : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "EncryptedTitle",
                table: "FileGroups",
                type: "character varying(2048)",
                maxLength: 2048,
                nullable: true);

            // Encrypted bundles made before this sent their title in plain text, readable without the passkey.
            // They lose their heading rather than keep exposing it (none can be re-encrypted: the server has no key).
            migrationBuilder.Sql("""UPDATE "FileGroups" SET "Title" = NULL WHERE "IsEncrypted";""");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "EncryptedTitle",
                table: "FileGroups");
        }
    }
}
