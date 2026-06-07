// Test fixture: plugin that never sends "ready" (for timeout tests)
// Just keep the process alive without sending IPC:{"type":"ready"}
setInterval(() => {}, 60000);
