import express from 'express';
import * as scrapeController from '../controllers/scrape.controller.js';

const router = express.Router();

// POST /scrape/search -> body: { title, composer, maxResults }
router.post('/search', scrapeController.scrapeByQuery);

export default router;
