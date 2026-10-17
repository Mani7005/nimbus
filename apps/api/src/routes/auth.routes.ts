import { Router } from "express";
import {
  register,
  login,
  me,
} from "../controllers/auth.controller.js";

import { authenticate } from "../middleware/auth.middleware.js";
import { loginRateLimit, registerRateLimit } from "../middleware/rate-limiters.js";
import { validateBody } from "../middleware/validate.middleware.js";
import { loginSchema, registerSchema } from "../validators/auth.validator.js";

const router = Router();

// Limits run first, so malformed attempts count too.
router.post("/register", registerRateLimit, validateBody(registerSchema), register);

router.post("/login", loginRateLimit, validateBody(loginSchema), login);

router.get("/me", authenticate, me);

export default router;
