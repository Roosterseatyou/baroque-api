import express from 'express'
import * as googleController from '../controllers/google.controller.js'
import { authenticate } from '../middleware/auth.middleware.js'

const router = express.Router()

// OAuth flow endpoints (require auth to map to existing user session)
router.get('/authorize', authenticate, googleController.authorize)
router.get('/callback', googleController.callback)
router.get('/status', authenticate, googleController.status)

// API endpoints to list and fetch spreadsheets
router.get('/files', authenticate, googleController.listFiles)
router.get('/sheets/:fileId/metadata', authenticate, googleController.getMetadata)
router.get('/sheets/:fileId/values', authenticate, googleController.getValues)

// Dev-only debug endpoint to inspect stored oauth_info (masked)
router.get('/debug', authenticate, googleController.debugInfo)
// Dev-only tokeninfo endpoint to inspect granted scopes on the stored access_token
router.get('/tokeninfo', authenticate, googleController.tokenInfo)
// Dev-only reset endpoint to delete stored oauth_info so you can force a fresh grant
router.post('/reset', authenticate, googleController.resetConnection)
// Dev-only list recent oauth_states rows for debugging
router.get('/states', authenticate, googleController.listOauthStates)

export default router
