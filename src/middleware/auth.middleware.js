import { verifyToken } from "../utils/jwt.js";

export function authenticate(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).json({ message: "Authorization header missing" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ message: "Token missing" });
  }

  try {
    const user = verifyToken(token);
    if (!user) {
      return res.status(403).json({ message: "Invalid or expired token" });
    }

    // Normalize token payload: some code signs with { userId } while others expect { id }
    if (user.userId && !user.id) {
      user.id = user.userId;
    }

    req.user = user; // Attach user info to request object
    next();
  } catch (error) {
    return res.status(403).json({ message: "Invalid or expired token" });
  }
}
