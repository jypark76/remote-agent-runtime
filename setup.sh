#!/bin/bash
set -e
echo "=== Remote Agent Runtime — setup ==="

npm install

cat <<'MSG'

Done. Next steps:

  1. Deploy the relay somewhere reachable (any host that speaks WebSocket):
       node relay/server.js

  2. Start the host agent on the machine that has the agent CLI installed:
       ADMIN_PASS=... USER_PASS=... \
       RELAY_URL=wss://your-relay RELAY_TOKEN=... \
       node server.js

  3. Open the relay URL on your phone with ?token=<RELAY_TOKEN>

MSG
