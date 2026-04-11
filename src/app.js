import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import orgsRoutes from "./routes/orgs.routes.js";
import librariesRoutes from "./routes/libraries.routes.js";
import piecesRoutes from "./routes/pieces.routes.js";
import scrapeRoutes from "./routes/scrape.routes.js";
import googleRoutes from "./routes/google.routes.js";
import invitationsRoutes from "./routes/invitations.routes.js";
import db from "./config/knex.js";

const app = express();

// Allow frontend origin and api origin. Default FRONTEND_ORIGIN to local dev host when not set
// so that local frontend (vite at :5173) can receive HttpOnly cookies during development.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
const allowedOrigins = [FRONTEND_ORIGIN, process.env.API_ORIGIN].filter(
  Boolean,
);

// In development allow any origin so the browser will accept cookies from the server when
// the frontend is served from localhost:5173 (Vite). In production use a restricted list.
if (process.env.NODE_ENV !== "production") {
  app.use(cors({ origin: true, credentials: true }));
} else {
  app.use(cors({ origin: allowedOrigins, credentials: true }));
}

app.use(cookieParser());
// Allow configuring the maximum request body size via env var. Defaults to 1mb which
// is larger than the body-parser default and should prevent PayloadTooLargeError for
// typical JSON requests. Set REQUEST_BODY_LIMIT (e.g. '10mb') in your environment
// if you expect larger payloads (file uploads should use multipart/form-data instead).
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || "1mb";
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
// Also support urlencoded payloads (forms) with the same limit
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

// health check
app.get("/", (req, res) => res.json({ status: "ok" }));
app.get("/healthz", async (req, res) => {
  try {
    // simple db check
    await db.raw("select 1 as ok");
    res.json({ status: "ok", db: true });
  } catch (err) {
    console.error(
      "healthz db check failed",
      err && err.message ? err.message : err,
    );
    res
      .status(503)
      .json({ status: "fail", db: false, error: err && err.message });
  }
});

app.use("/auth", authRoutes);
app.use("/users", usersRoutes);
app.use("/organizations", orgsRoutes);
app.use("/libraries", librariesRoutes);
app.use("/pieces", piecesRoutes);
app.use("/scrape", scrapeRoutes);
app.use("/invitations", invitationsRoutes);
// Mount integrations routes only when explicitly enabled. The frontend login/signup
// flow uses the auth routes (`/auth/google`), so by default we keep integrations
// disabled to avoid confusion now that Drive/Sheets integrations were removed.
const ENABLE_GOOGLE_INTEGRATION =
  process.env.ENABLE_GOOGLE_INTEGRATION === "true";
if (ENABLE_GOOGLE_INTEGRATION) {
  app.use("/integrations/google", googleRoutes);
  console.log("Google integration routes enabled at /integrations/google");
} else {
  console.log(
    "Google integration routes are disabled (ENABLE_GOOGLE_INTEGRATION!=true). Use /auth/google for login/signup.",
  );
}

// Optional autofill/search routes (mount only when ENABLE_AUTOFILL=true)
if (process.env.ENABLE_AUTOFILL === "true") {
  (async () => {
    try {
      const scrapeSearchRoutes =
        await import("./routes/scrape_search.routes.js");
      app.use("/scrape", scrapeSearchRoutes.default);
      console.log("Autofill/search routes enabled via ENABLE_AUTOFILL");
    } catch (err) {
      console.warn("Failed to load scrape_search routes:", err && err.message);
    }
  })();
}

// Generic error handler to convert body-parser / raw-body size errors into a clear
// 413 Payload Too Large response. This should be registered after the body parsers
// and route mounts so it catches parsing errors early.
app.use((err, req, res, next) => {
  if (!err) return next();
  // raw-body throws a 'PayloadTooLargeError' (type from http-errors) when the
  // request body exceeds the configured limit. Normalize into a 413 response.
  if (
    err.type === "entity.too.large" ||
    err.type === "request.entity.too.large" ||
    err.status === 413 ||
    err.statusCode === 413
  ) {
    console.warn(
      "Request body too large:",
      err && err.message ? err.message : err,
    );
    return res
      .status(413)
      .json({
        error: "PayloadTooLargeError",
        message: "Request entity too large",
      });
  }
  // pass other errors along
  return next(err);
});

export default app;
