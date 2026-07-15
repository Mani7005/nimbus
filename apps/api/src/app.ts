import express from "express";

const app = express();

// Parse JSON request body
app.use(express.json());

// Health Check Route
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Nimbus API",
    message: "API is running successfully 🚀",
  });
});

export default app;