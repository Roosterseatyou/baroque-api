import * as authService from '../services/auth.service.js';
import * as googleAuthService from '../services/googleAuth.service.js';
import { generateToken } from '../utils/jwt.js';

export async function register(req, res) {
    try {
        const { email, name, password } = req.body;
        const user = await authService.registerUser({ email, name, password });
        res.status(201).json(user);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function login(req, res) {
    try {
        const { email, password } = req.body;
        const { token } = await authService.loginUser({ email, password });
        res.status(200).json({ token });
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
}

export async function googleAuth(req, res) {
    const url = googleAuthService.getGoogleAuth();
    return res.redirect(url);
}

export async function googleCallback(req, res) {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).json({ error: 'code not found' });
        const googleUser = await googleAuthService.exchangeCodeForUser(code);
        console.log("GOOGLE PROFILE:", googleUser);
        const user = await authService.createOrFindUserByGoogle(googleUser);
        console.log("USER BEFORE JWT:", user);
        const token = generateToken({ id: user.id, email: user.email });
        res.status(200).json({ token, user });
    } catch (error) {
        console.log("GOOGAUTH ERR========\n" + error);
        res.status(500).json({ error: error.message });
    }
}