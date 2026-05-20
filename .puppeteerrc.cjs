const { join } = require("path");

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Downloads Chrome into the project folder instead of global user cache.
  // This ensures it works identically on Windows, Render, and any Linux server.
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};