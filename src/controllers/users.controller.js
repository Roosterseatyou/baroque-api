import * as usersService from "../services/users.service.js";

export async function getUserProfile(req, res) {
  try {
    const user = await usersService.getUserById(req.user.id);
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function me(req, res) {
  try {
    const user = await usersService.getCurrentUser(req.user.id);
    res.status(200).json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function updateUserProfile(req, res) {
  try {
    const { name, username, discriminator, email } = req.body;
    const updatedUser = await usersService.updateUserProfile(req.user.id, {
      name,
      username,
      discriminator,
      email,
    });
    res.status(200).json(updatedUser);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

export async function deleteUser(req, res) {
  try {
    await usersService.deleteUser(req.user.id);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function createUserData(req, res) {
  try {
    const { orgName } = req.body || {};
    const org = await usersService.createUserData(req.user.id, { orgName });
    res.status(201).json(org);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

// DELETE /users/data - safe deletion of user account and associated data
export async function deleteUserData(req, res) {
  try {
    await usersService.deleteUserData(req.user.id);
    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function restoreUser(req, res) {
  try {
    const requesterId = req.user && req.user.id;
    const targetUserId = req.params.userId || requesterId;
    // Allow self-restore or admin secret override
    const adminSecret = req.get("X-ADMIN-SECRET") || process.env.ADMIN_SECRET;
    if (targetUserId !== requesterId && !adminSecret)
      return res.status(403).json({ error: "Forbidden" });
    // If admin secret provided, accept it (no verification beyond presence). For stricter control, compare to env ADMIN_SECRET.
    if (
      adminSecret &&
      process.env.ADMIN_SECRET &&
      adminSecret !== process.env.ADMIN_SECRET
    )
      return res.status(403).json({ error: "Forbidden" });

    await usersService.restoreUser(targetUserId);
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function getUserOrganizations(req, res) {
  try {
    const organizations = await usersService.getUserOrganizations(req.user.id);
    res.status(200).json(organizations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function getDeletedOrganizations(req, res) {
  try {
    const organizations = await usersService.getDeletedOrganizationsForUser(
      req.user.id,
    );
    res.status(200).json(organizations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

export async function getUserLibraries(req, res) {
  try {
    const libraries = await usersService.getUserLibraries(req.user.id);
    res.status(200).json(libraries);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// Debug: list audit entries related to organization deletions that reference the current user
// ...existing code...
