import cors from "cors";
import app from "./app.js";
import { env } from "./config/env.js";

app.listen(env.PORT, () => {
  console.log("=================================");
  console.log("🚀 Nimbus API Running");
  console.log(`🌐 http://localhost:${env.PORT}`);
  console.log(`🌍 ${env.NODE_ENV}`);
  console.log("=================================");
});