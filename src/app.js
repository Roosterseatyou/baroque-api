import express from 'express';

import authRoutes from "./routes/auth.routes.js";
import usersRoutes from "./routes/users.routes.js";
import orgsRoutes from "./routes/orgs.routes.js";
import librariesRoutes from "./routes/libraries.routes.js";
import piecesRoutes from "./routes/pieces.routes.js";

const app = express();

app.use(express.json());

app.use('/auth', authRoutes);
app.use('/users', usersRoutes);
app.use('/organizations', orgsRoutes);
app.use('/libraries', librariesRoutes);
app.use('/pieces', piecesRoutes);

export default app;
