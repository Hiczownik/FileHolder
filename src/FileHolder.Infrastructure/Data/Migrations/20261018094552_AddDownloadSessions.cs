using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace FileHolder.Infrastructure.Data.Migrations
{
    /// <inheritdoc />
    public partial class AddDownloadSessions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "DownloadSessions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    FileGroupId = table.Column<Guid>(type: "uuid", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    ExpiresAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_DownloadSessions", x => x.Id);
                    table.ForeignKey(
                        name: "FK_DownloadSessions_FileGroups_FileGroupId",
                        column: x => x.FileGroupId,
                        principalTable: "FileGroups",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_DownloadSessions_ExpiresAt",
                table: "DownloadSessions",
                column: "ExpiresAt");

            migrationBuilder.CreateIndex(
                name: "IX_DownloadSessions_FileGroupId",
                table: "DownloadSessions",
                column: "FileGroupId");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "DownloadSessions");
        }
    }
}
