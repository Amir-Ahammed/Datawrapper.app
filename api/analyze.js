const { handleUpload } = require("../server");

module.exports = async function analyze(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    await handleUpload(req, res, { persist: false });
  } catch (error) {
    console.error("Function error:", error);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
};
