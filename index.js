const express = require("express");
const { MongoClient } = require("mongodb");

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const SCALEWAY_API_KEY = process.env.SCALEWAY_API_KEY;
const SCALEWAY_PROJECT_ID = process.env.SCALEWAY_PROJECT_ID;


const GRID_INTENSITY_KG_PER_KWH = 0.065;

// Energy-per-token estimates (Wh/token) by rough model size class.
// These are research estimates, used as fallback if Scaleway API unavailable.
function energyPerToken(model) {
  const m = (model || "").toLowerCase();
  if (m.includes("235b") || m.includes("397b") || m.includes("medium")) {
    return 0.0006; 
  }
  if (m.includes("30b") || m.includes("12b") || m.includes("8b")) {
    return 0.00015; 
  }
  return 0.0003; 
}

function co2FromTokens(totalTokens, model) {
  const wh = totalTokens * energyPerToken(model);
  const kwh = wh / 1000;
  const co2Kg = kwh * GRID_INTENSITY_KG_PER_KWH;
  return {
    totalTokens,
    energyWh: Number(wh.toFixed(4)),
    co2Grams: Number((co2Kg * 1000).toFixed(4)),
    source: "estimate", // Mark as estimate
  };
}


// Fetch actual measured CO2 from Scaleway's Environmental Footprint API
async function getScalewayActualCO2(conversationStartTime, conversationEndTime) {
  if (!SCALEWAY_API_KEY || !SCALEWAY_PROJECT_ID) {
    console.log(
      "⚠️  Scaleway API credentials not configured, will use estimates"
    );
    return null;
  }

  try {
    // Scaleway Environmental Footprint API endpoint (v1 API)
    // This fetches carbon emissions data for a given time range and project
    const url = new URL(
      `https://api.scaleway.com/environmental-footprint/v1/carbon-emissions`
    );

    url.searchParams.append("project_id", SCALEWAY_PROJECT_ID);
    url.searchParams.append("start_date", conversationStartTime);
    url.searchParams.append("end_date", conversationEndTime);
    url.searchParams.append("group_by", "day"); // Group by day for accuracy

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "X-Auth-Token": SCALEWAY_API_KEY,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(
        `⚠️  Scaleway API returned ${response.status}, falling back to estimates`
      );
      return null;
    }

    const data = await response.json();

    // Sum CO2 from all services (especially Generative APIs)
    let totalCO2Grams = 0;
    if (data.carbon_emissions && Array.isArray(data.carbon_emissions)) {
      for (const emission of data.carbon_emissions) {
        // CO2 is typically in kg, convert to grams
        if (emission.co2_kg) {
          totalCO2Grams += emission.co2_kg * 1000;
        }
      }
    }

    if (totalCO2Grams > 0) {
      return {
        co2Grams: Number(totalCO2Grams.toFixed(4)),
        source: "scaleway_api", // Mark as from Scaleway
      };
    }

    return null;
  } catch (err) {
    console.log(
      `⚠️  Scaleway API error (${err.message}), falling back to estimates`
    );
    return null;
  }
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

  // Get conversation start and end times for API query
  const firstMsg = await messages.findOne({ conversationId });
  const conversationStart = firstMsg
    ? new Date(firstMsg.createdAt).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];
  const conversationEnd = lastMsg
    ? new Date(lastMsg.createdAt).toISOString().split("T")[0]
    : new Date().toISOString().split("T")[0];

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    model: lastMsg ? lastMsg.model : null,
    startTime: conversationStart,
    endTime: conversationEnd,
  };
}

// --- MCP server (JSON-RPC over HTTP, streamable) ---
const app = express();
app.use(express.json());

const TOOLS = [
  {
    name: "get_conversation_co2",
    description:
      "Get the real token usage and CO2 emissions for a specific LibreChat conversation. Uses actual Scaleway Environmental Footprint API if configured, otherwise estimates based on token count.",
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

        // --- PRIMARY: Try Scaleway's actual API first ---
        let co2Data = await getScalewayActualCO2(
          usage.startTime,
          usage.endTime
        );

        // --- FALLBACK: If API fails or unavailable, use estimation ---
        if (!co2Data) {
          co2Data = co2FromTokens(usage.totalTokens, usage.model);
        }

        // Build detailed response
        const sourceLabel =
          co2Data.source === "scaleway_api"
            ? "**Measured** from Scaleway's Environmental Footprint API"
            : "**Estimated** based on token count and research energy data";

        const text =
          `This conversation used ${usage.totalTokens} tokens ` +
          `(${usage.promptTokens} input, ${usage.completionTokens} output) ` +
          `on model "${usage.model || "unknown"}".\n\n` +
          `**CO2e: ${co2Data.co2Grams} g**\n` +
          `Source: ${sourceLabel}\n\n`;

        // Add details based on source
        let detailText = "";
        if (co2Data.source === "scaleway_api") {
          detailText =
            `This figure comes directly from Scaleway's measured ` +
            `Environmental Footprint data for your project between ` +
            `${usage.startTime} and ${usage.endTime}. ` +
            `This includes all Scaleway services used during this period ` +
            `(especially Generative APIs).`;
        } else {
          const energyWh = co2Data.energyWh;
          detailText =
            `Estimated energy: ${energyWh} Wh\n\n` +
            `This figure is based on actual recorded token transactions, ` +
            `Scaleway's published Paris-region (PAR-2) grid carbon intensity ` +
            `of ${GRID_INTENSITY_KG_PER_KWH} kgCO2e/kWh, and a published ` +
            `research estimate for energy-per-token (since no provider ` +
            `publishes measured per-request energy figures).\n\n` +
            `💡 **Tip**: Set SCALEWAY_API_KEY and SCALEWAY_PROJECT_ID ` +
            `environment variables to use Scaleway's actual measured CO2 instead.`;
        }

        const finalText = text + detailText;

        return res.json({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: finalText }] },
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
          serverInfo: { name: "co2-tracker", version: "2.0.0" },
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
  if (SCALEWAY_API_KEY && SCALEWAY_PROJECT_ID) {
    console.log(
      "Scaleway API credentials configured - using actual measured CO2"
    );
  } else {
    console.log(
      "Scaleway API credentials not configured - using estimate mode"
    );
  }
});