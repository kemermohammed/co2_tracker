const express = require("express");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;

// --- CO2 calculation constants ---
// Grid carbon intensity for Scaleway PAR-2 (Paris), published by Scaleway.
const GRID_INTENSITY_KG_PER_KWH = 0.065;

// Energy-per-token estimates (Wh/token) by rough model size class.
// These are research estimates, not measured Scaleway figures.
function energyPerToken(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("235b") || m.includes("397b") || m.includes("medium")) {
    return 0.0006; // very large models
  }
  if (m.includes("30b") || m.includes("12b") || m.includes("8b")) {
    return 0.00015; // small/mid models
  }
  return 0.0003; // default: ~70-120b class
}

function co2FromTokens(totalTokens, model) {
  const wh = totalTokens * energyPerToken(model);
  const kwh = wh / 1000;
  const co2Kg = kwh * GRID_INTENSITY_KG_PER_KWH;
  return {
    totalTokens,
    energyWh: Number(wh.toFixed(4)),
    co2Grams: Number((co2Kg * 1000).toFixed(4)),
  };
}

let db;
async function getDb() {
  if (db) return db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db();
  return db;
}

// Sum real token usage for a conversation from the transactions collection.
// rawAmount is stored negative for spend, so we sum absolute values.
async function getConversationTokens(conversationId) {
  const database = await getDb();
  const transactions = database.collection("transactions");

  const results = await transactions
    .aggregate([
      { $match: { conversationId } },
      {
        $group: {
          _id: "$tokenType",
          total: { $sum: { $abs: "$rawAmount" } },
        },
      },
    ])
    .toArray();

  let promptTokens = 0;
  let completionTokens = 0;
  for (const r of results) {
    if (r._id === "prompt") promptTokens = r.total;
    if (r._id === "completion") completionTokens = r.total;
  }

  // Grab the most recent model used in this conversation for energy estimate.
  const messages = database.collection("messages");
  const lastMsg = await messages.findOne(
    { conversationId, isCreatedByUser: { $ne: true } },
    { sort: { createdAt: -1 } }
  );

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    model: lastMsg ? lastMsg.model : null,
  };
}

// --- MCP server (JSON-RPC over HTTP, streamable) ---
const app = express();
app.use(express.json());

const TOOLS = [
  {
    name: "get_conversation_co2",
    description:
      "Get the real token usage and estimated CO2 emissions for a specific LibreChat conversation, using actual recorded token transactions.",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "The LibreChat conversation ID to calculate CO2 for.",
        },
      },
      required: ["conversationId"],
    },
  },
];

app.post("/mcp", async (req, res) => {
  const { method, params, id } = req.body;

  try {
    if (method === "tools/list") {
      return res.json({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    }

    if (method === "tools/call") {
      const { name, arguments: args } = params;

      if (name === "get_conversation_co2") {
        const usage = await getConversationTokens(args.conversationId);

        if (usage.totalTokens === 0) {
          return res.json({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: "No recorded token usage found for this conversation yet.",
                },
              ],
            },
          });
        }

        const co2 = co2FromTokens(usage.totalTokens, usage.model);

        const text =
          `This conversation used ${usage.totalTokens} tokens ` +
          `(${usage.promptTokens} input, ${usage.completionTokens} output) ` +
          `on model "${usage.model || "unknown"}".\n\n` +
          `Estimated energy: ${co2.energyWh} Wh\n` +
          `Estimated CO2e: ${co2.co2Grams} g\n\n` +
          `Based on actual recorded token transactions, Scaleway's published ` +
          `Paris-region (PAR-2) grid carbon intensity of ${GRID_INTENSITY_KG_PER_KWH} kgCO2e/kWh, ` +
          `and a published research estimate for energy-per-token. Scaleway does not ` +
          `publish a measured per-request energy figure, so this remains an estimate.`;

        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text }] },
        });
      }

      return res.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      });
    }

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "co2-tracker", version: "1.0.0" },
        },
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Unknown method: ${method}` },
    });
  } catch (err) {
    return res.json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: err.message },
    });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`CO2 MCP server listening on port ${PORT}`);
});
