# CO2 MCP server for LibreChat

A small MCP server that gives LibreChat a real tool: `get_conversation_co2`.

When you ask LibreChat something like *"how much CO2 did this conversation use?"*,
the model can call this tool, which:

1. Looks up the real token usage for the current conversation from LibreChat's
   own `transactions` collection in MongoDB (the same data LibreChat uses
   internally for cost/balance tracking).
2. Converts total tokens to estimated energy (Wh) using a published
   research estimate for energy-per-token, scaled by rough model size.
3. Converts energy to CO2e using Scaleway's own published grid carbon
   intensity for the Paris (PAR-2) region: 0.065 kgCO2e/kWh.

## What's real vs estimated

- **Real**: token counts (pulled directly from MongoDB), Scaleway's grid
  carbon intensity (their own published figure).
- **Estimated**: energy-per-token. No AI provider, including Scaleway,
  publishes a measured per-token energy figure, so this uses a
  commonly-cited research range.

## Deploying on Railway

1. Push this folder to a new GitHub repo (or use Railway's "Deploy from
   local directory" / drag-and-drop if available).
2. In your existing "amiable-creativity" Railway project, click
   **+ Add** → deploy this repo as a new service.
3. Set one environment variable on this new service:
   - `MONGO_URI` — point it at the same MongoDB instance LibreChat uses.
     Railway lets you reference another service's connection string as
     a variable (e.g. `${{MongoDB.MONGO_URL}}` depending on the exact
     variable name MongoDB exposes in your project — check the MongoDB
     service's Variables tab for the exact name).
4. Railway will assign this service an internal address like
   `co2-mcp-server.railway.internal` — note that down, you'll need it
   for the next step.
5. In your `librechat.yaml` gist, add an `mcpServers` block (see
   `librechat-mcp-snippet.yaml` in this folder) pointing at this new
   service's URL, then redeploy LibreChat the same way you did before
   (Apply changes → Deploy).
6. Ask LibreChat: "how much CO2 has this conversation used?"
