import app from "./app.js";

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("=================================");
  console.log(`🚀 Nimbus API Running`);
  console.log(`🌐 http://localhost:${PORT}`);
  console.log("=================================");
});