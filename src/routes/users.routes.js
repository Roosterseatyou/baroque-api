import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import * as usersController from '../controllers/users.controller.js';

const router = express.Router();

router.get('/me', authenticate, usersController.me);
router.get('/:userId', authenticate, usersController.getUserProfile);
router.put('/:userId', authenticate, usersController.updateUserProfile);
router.delete('/:userId', authenticate, usersController.deleteUser);
router.get('/:userId/libraries', authenticate, usersController.getUserLibraries);
router.get('/:userId/organizations', authenticate, usersController.getUserOrganizations);

export default router;