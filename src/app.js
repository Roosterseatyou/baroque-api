import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import orgsRoutes from "./routes/orgs.routes.js";
import librariesRoutes from "./routes/libraries.routes.js";
import piecesRoutes from "./routes/pieces.routes.js";
import scrapeRoutes from "./routes/scrape.routes.js";
import googleRoutes from "./routes/google.routes.js";
import db from './config/knex.js';

const app = express();

// Allow frontend origin and api origin
const allowedOrigins = [process.env.FRONTEND_ORIGIN, process.env.API_ORIGIN].filter(Boolean);
app.use(cors({
    origin: allowedOrigins,
    credentials: true
}));

app.use(cookieParser());
app.use(express.json());

// health check
app.get('/', (req, res) => res.json({ status: 'ok' }));
app.get('/healthz', async (req, res) => {
    try {
        // simple db check
        await db.raw('select 1 as ok');
        res.json({ status: 'ok', db: true });
    } catch (err) {
        console.error('healthz db check failed', err && err.message ? err.message : err);
        res.status(503).json({ status: 'fail', db: false, error: err && err.message });
    }
});

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/organizations', orgsRoutes);
app.use('/libraries', librariesRoutes);
app.use('/pieces', piecesRoutes);
app.use('/scrape', scrapeRoutes);
app.use('/integrations/google', googleRoutes);

// Optional autofill/search routes (mount only when ENABLE_AUTOFILL=true)
if (process.env.ENABLE_AUTOFILL === 'true') {
    (async () => {
        try {
            const scrapeSearchRoutes = await import('./routes/scrape_search.routes.js');
            app.use('/scrape', scrapeSearchRoutes.default);
            console.log('Autofill/search routes enabled via ENABLE_AUTOFILL');
        } catch (err) {
            console.warn('Failed to load scrape_search routes:', err && err.message);
        }
    })();
}

export default app;
