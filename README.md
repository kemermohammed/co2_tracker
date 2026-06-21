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
- **Estimated**: energy-per-token. 
