# Phase 1 demonstration (local only)

1. Start Vite using the README commands. Point out **Demo mode** and Settings → cloud not configured. All displayed figures come from this browser's data.
2. Download a sample from its file action menu and open the labeled text/CSV/JSON content. Upload a small actual TXT/PDF/image using browse or drag/drop; download it and compare bytes manually. A simulated saving indicator describes browser persistence, not network throughput.
3. My Files → search by name, filter folder/type, sort, switch grid/list. Create a folder and move/rename an uploaded file. The content stays unchanged because folders and names are metadata.
4. Open Architecture notes' version history; it includes a retained sample draft. Choose that draft, confirm restore and download the restored content. Restore creates a new current version and leaves prior versions retained.
5. Move a file to trash. Verify active file count changes. In Trash, inspect its delete marker and select a retained **content** version to restore. A delete marker has no file content.
6. Create a one-minute demo sharing link, copy and open it in this same browser/origin. After expiry, download fails and status updates. Explain that this cannot share with another device, and that real S3 links are bearer capabilities. The demo blocks downloads of trashed files; a real version-pinned URL may remain usable until expiry.
7. Inspect Activity and Analytics after these operations; totals update from stored data, retained content is separate from active content, and these are not AWS billing statistics.
8. Settings → Clear workspace, confirm and inspect the empty states. Reset samples to start again. Both operations permanently erase this browser's prior demo uploads and links.

The Python API can be tested independently with pytest. Upload confirmation there is a state simulator without file bytes; transfer endpoints deliberately return 501. Do not represent local behavior as evidence of deployed S3, DynamoDB, email, monitoring or schedules.
