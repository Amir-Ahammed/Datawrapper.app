const { handleUpload } = require("../server");

module.exports = async function analyze(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  await handleUpload(req, res, { persist: false });
};
