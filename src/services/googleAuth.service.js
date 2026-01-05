const {
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
} = process.env;

const GOOGLE_OAUTH2_AUTH_BASE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_OAUTH2_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_OAUTH2_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';

export function getGoogleAuth() {
    const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: 'openid email profile',
        access_type: 'offline',
        prompt: 'consent'
    });

    return `${GOOGLE_OAUTH2_AUTH_BASE_URL}?${params.toString()}`;
}

export async function exchangeCodeForUser(code) {
    const tokenResponse = await fetch(GOOGLE_OAUTH2_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            redirect_uri: GOOGLE_REDIRECT_URI,
            grant_type: 'authorization_code'
        })
    });

    if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error("GOOGLE TOKEN ERROR:", errorText);
        throw new Error('Failed to exchange code for tokens');
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;
    const userInfoResponse = await fetch(GOOGLE_OAUTH2_USERINFO_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        }
    });
    if (!userInfoResponse.ok) {
        throw new Error('Failed to fetch user info from Google');
    }

    const userInfo = await userInfoResponse.json();
    return {
        googleId: userInfo.sub || userInfo.id,
        email: userInfo.email,
        name: userInfo.name,
        avatarUrl: userInfo.picture,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token
    };
}