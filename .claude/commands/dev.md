---
allowed-tools: Bash(pkill:*), Bash(go build:*)
description: Kill running server, rebuild, and restart the UI
---

# Dev Restart

Stop any running kindle-send-auto process, rebuild the binary, and start the UI server.

Steps:
1. Kill existing process (if running)
2. Rebuild the Go binary
3. Start the UI server

Run these commands:

```bash
killall kindle-send-auto 2>/dev/null || true
```

```bash
cd /home/michael/projects/kindle-send-auto && go build -o kindle-send-auto .
```

```bash
cd /home/michael/projects/kindle-send-auto && ./kindle-send-auto ui
```

Server will be available at http://localhost:8080
