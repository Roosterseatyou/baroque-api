import express from "express";
import * as scrapeController from "../controllers/scrape.controller.js";

const router = express.Router();

// POST /scrape (fetch metadata for a specific URL)
router.post("/", scrapeController.scrapeUrl);

export default router;
